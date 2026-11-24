
'use strict';

const mongoose = require('mongoose');
const { REQUIRED_INDEX } = require('../utils/affiliatePromotionIndexReadiness');

const COLLECTION_NAME = 'affiliatepromotions';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

function parseArguments(argv) {
  const options = {
    execute: false,
    confirmProduction: false,
    expectedHost: null,
    expectedDatabase: null,
  };

  for (const arg of argv) {
    if (arg === '--execute') {
      options.execute = true;
    } else if (arg === '--confirm-production') {
      options.confirmProduction = true;
    } else if (arg.startsWith('--expect-host=')) {
      options.expectedHost = arg
        .slice('--expect-host='.length)
        .trim()
        .toLowerCase();
    } else if (arg.startsWith('--expect-db=')) {
      options.expectedDatabase = arg
        .slice('--expect-db='.length)
        .trim();
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.expectedHost || !options.expectedDatabase) {
    throw new Error(
      'Both --expect-host and --expect-db are required. Do not guess these values.',
    );
  }

  if (options.execute && !options.confirmProduction) {
    throw new Error(
      'Execution requires both --execute and --confirm-production.',
    );
  }

  if (options.confirmProduction && !options.execute) {
    throw new Error(
      '--confirm-production is only valid together with --execute.',
    );
  }

  return options;
}

function inspectTarget(uri, options) {
  if (!uri) {
    throw new Error('MONGO_URI is not configured.');
  }

  let parsed;

  try {
    parsed = new URL(uri);
  } catch {
    throw new Error('MONGO_URI is not a valid MongoDB URL.');
  }

  if (!['mongodb:', 'mongodb+srv:'].includes(parsed.protocol)) {
    throw new Error('MONGO_URI must use mongodb:// or mongodb+srv://.');
  }

  const actualHost = parsed.hostname.toLowerCase();
  const actualDatabase = decodeURIComponent(
    parsed.pathname.replace(/^\//, ''),
  );

  if (!actualDatabase) {
    throw new Error('MONGO_URI does not specify a database name.');
  }

  if (LOCAL_HOSTS.has(actualHost)) {
    throw new Error(
      'Production provisioning refuses to connect to a local MongoDB host.',
    );
  }

  if (actualHost !== options.expectedHost) {
    throw new Error(
      'MongoDB hostname does not match --expect-host. Refusing to continue.',
    );
  }

  if (actualDatabase !== options.expectedDatabase) {
    throw new Error(
      'Database name does not match --expect-db. Refusing to continue.',
    );
  }

  if (options.execute && process.env.NODE_ENV !== 'production') {
    throw new Error('Execution requires NODE_ENV=production.');
  }

  return {
    host: actualHost,
    database: actualDatabase,
  };
}

function hasRequiredDefinition(index) {
  const actualKeys = Object.entries(index.key || {});
  const expectedKeys = Object.entries(REQUIRED_INDEX.key);

  const extraOptions = Object.fromEntries(
    Object.entries(index).filter(
      ([key]) =>
        !['name', 'key', 'v', 'ns', 'background'].includes(key),
    ),
  );

  return (
    index.name === REQUIRED_INDEX.name &&
    JSON.stringify(actualKeys) === JSON.stringify(expectedKeys) &&
    JSON.stringify(extraOptions) === JSON.stringify({ unique: true })
  );
}

async function countAggregation(collection, pipeline) {
  const result = await collection.aggregate([
    ...pipeline,
    { $count: 'count' },
  ]).toArray();

  return result[0]?.count || 0;
}

async function validateExistingDocuments(db, collection) {
  const invalidFieldDocuments = await collection.countDocuments({
    $expr: {
      $or: [
        { $ne: [{ $type: '$affiliate' }, 'objectId'] },
        { $ne: [{ $type: '$product' }, 'objectId'] },
      ],
    },
  });

  if (invalidFieldDocuments > 0) {
    throw new Error(
      `Validation failed: ${invalidFieldDocuments} documents have missing or invalid affiliate/product fields.`,
    );
  }

  const duplicateGroups = await countAggregation(collection, [
    {
      $group: {
        _id: {
          affiliate: '$affiliate',
          product: '$product',
        },
        count: { $sum: 1 },
      },
    },
    { $match: { count: { $gt: 1 } } },
  ]);

  if (duplicateGroups > 0) {
    throw new Error(
      `Validation failed: ${duplicateGroups} duplicate affiliate/product groups exist.`,
    );
  }

  const danglingAffiliates = await countAggregation(collection, [
    {
      $lookup: {
        from: 'affiliates',
        localField: 'affiliate',
        foreignField: '_id',
        as: '_matchedAffiliate',
      },
    },
    {
      $match: {
        '_matchedAffiliate.0': { $exists: false },
      },
    },
  ]);

  const danglingProducts = await countAggregation(collection, [
    {
      $lookup: {
        from: 'merchantproducts',
        localField: 'product',
        foreignField: '_id',
        as: '_matchedProduct',
      },
    },
    {
      $match: {
        '_matchedProduct.0': { $exists: false },
      },
    },
  ]);

  if (danglingAffiliates > 0 || danglingProducts > 0) {
    throw new Error(
      `Validation failed: ${danglingAffiliates} dangling affiliate references and ${danglingProducts} dangling product references exist.`,
    );
  }

  return {
    invalidFieldDocuments,
    duplicateGroups,
    danglingAffiliates,
    danglingProducts,
  };
}

async function inspectExistingIndexes(db, collectionExists) {
  if (!collectionExists) {
    return {
      indexes: [],
      requiredIndexExists: false,
    };
  }

  const indexes = await db
    .collection(COLLECTION_NAME)
    .listIndexes()
    .toArray();

  const sameName = indexes.find(
    (index) => index.name === REQUIRED_INDEX.name,
  );

  if (sameName && !hasRequiredDefinition(sameName)) {
    throw new Error(
      `Index "${REQUIRED_INDEX.name}" exists with an incompatible definition. No changes made.`,
    );
  }

  if (sameName) {
    return {
      indexes,
      requiredIndexExists: true,
    };
  }

  const sameKey = indexes.find(
    (index) =>
      JSON.stringify(Object.entries(index.key || {})) ===
      JSON.stringify(Object.entries(REQUIRED_INDEX.key)),
  );

  if (sameKey) {
    throw new Error(
      `A conflicting index named "${sameKey.name}" already uses the required key. Manual review is required; no index will be replaced.`,
    );
  }

  return {
    indexes,
    requiredIndexExists: false,
  };
}

async function provision(db, execute) {
  let collectionExists = await db
    .listCollections(
      { name: COLLECTION_NAME },
      { nameOnly: true },
    )
    .hasNext();

  let validation = {
    invalidFieldDocuments: 0,
    duplicateGroups: 0,
    danglingAffiliates: 0,
    danglingProducts: 0,
  };

  if (collectionExists) {
    validation = await validateExistingDocuments(
      db,
      db.collection(COLLECTION_NAME),
    );
  }

  let indexState = await inspectExistingIndexes(
    db,
    collectionExists,
  );

  const plan = {
    collection: COLLECTION_NAME,
    collectionExists,
    createCollection: !collectionExists,
    requiredIndex: REQUIRED_INDEX,
    requiredIndexExists: indexState.requiredIndexExists,
    createIndex: !indexState.requiredIndexExists,
    validation,
    executed: false,
  };

  // Dry-run: inspect and report without modifying the database.
  if (!execute) {
    return plan;
  }

  // Create only the missing collection.
  if (!collectionExists) {
    try {
      await db.createCollection(COLLECTION_NAME);
      collectionExists = true;
    } catch (error) {
      if (
        error.code !== 48 &&
        error.codeName !== 'NamespaceExists'
      ) {
        throw error;
      }

      collectionExists = await db
        .listCollections(
          { name: COLLECTION_NAME },
          { nameOnly: true },
        )
        .hasNext();

      if (!collectionExists) {
        throw error;
      }
    }
  }

  // Revalidate immediately before index creation.
  validation = await validateExistingDocuments(
    db,
    db.collection(COLLECTION_NAME),
  );

  // Reinspect indexes to avoid relying on stale initial information.
  indexState = await inspectExistingIndexes(db, true);

  // Create only the required index if it is still missing.
  if (!indexState.requiredIndexExists) {
    await db.collection(COLLECTION_NAME).createIndex(
      REQUIRED_INDEX.key,
      {
        unique: true,
        name: REQUIRED_INDEX.name,
      },
    );
  }

  // Verify the required index after provisioning.
  const finalIndexes = await db
    .collection(COLLECTION_NAME)
    .listIndexes()
    .toArray();

  const verified = finalIndexes.some(hasRequiredDefinition);

  if (!verified) {
    throw new Error(
      'Provisioning ran, but final required-index verification failed.',
    );
  }

  return {
    ...plan,
    collectionExists: true,
    requiredIndexExists: true,
    validation,
    createCollection: plan.createCollection,
    createIndex: plan.createIndex,
    executed: true,
    verified: true,
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));

  const target = inspectTarget(
    process.env.MONGO_URI,
    options,
  );

  // Never print credentials or the full MongoDB URI.
  console.log(JSON.stringify({
    mode: options.execute ? 'EXECUTE' : 'DRY_RUN',
    target,
  }, null, 2));

  await mongoose.connect(
    process.env.MONGO_URI,
    { maxPoolSize: 2 },
  );

  try {
    const connectedDatabase =
      mongoose.connection.db.databaseName;

    if (connectedDatabase !== options.expectedDatabase) {
      throw new Error(
        'Connected database does not match the explicitly confirmed database.',
      );
    }

    const result = await provision(
      mongoose.connection.db,
      options.execute,
    );

    console.log(JSON.stringify(result, null, 2));

    if (!options.execute) {
      console.log(
        'DRY RUN ONLY: no collection or index was created.',
      );
    } else {
      console.log(
        'Provisioning completed and the required index was verified.',
      );
    }
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(
      `AffiliatePromotion production provisioning failed: ${error.message}`,
    );

    process.exitCode = 1;
  });
}

module.exports = {
  COLLECTION_NAME,
  parseArguments,
  inspectTarget,
  hasRequiredDefinition,
  validateExistingDocuments,
  inspectExistingIndexes,
  provision,
};
