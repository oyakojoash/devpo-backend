const fs = require('node:fs');
const dotenv = require('dotenv');
const mongoose = require('mongoose');
const { REQUIRED_INDEX } = require('../utils/affiliatePromotionIndexReadiness');

const COLLECTION_NAME = 'affiliatepromotions';

function getLocalDevDatabaseUri() {
  const envPath = '.env';
  const fileEnv = fs.existsSync(envPath) ? dotenv.parse(fs.readFileSync(envPath)) : {};
  const uri = process.env.MONGO_URI || fileEnv.MONGO_URI;
  if (!uri) throw new Error('MONGO_URI is not configured');

  let parsed;
  try {
    parsed = new URL(uri);
  } catch {
    throw new Error('MONGO_URI is not a valid MongoDB URL');
  }

  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  const isLocal = ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname);
  if (!isLocal || databaseName !== 'devpo') {
    throw new Error('AffiliatePromotion provisioning is restricted to the confirmed local devpo database');
  }
  return uri;
}

function hasRequiredDefinition(index) {
  const extraOptions = Object.fromEntries(
    Object.entries(index).filter(([key]) => !['name', 'key', 'v', 'ns', 'background'].includes(key)),
  );
  return index.name === REQUIRED_INDEX.name &&
    JSON.stringify(index.key) === JSON.stringify(REQUIRED_INDEX.key) &&
    JSON.stringify(extraOptions) === JSON.stringify({ unique: true });
}

async function countDuplicatePairs(collection) {
  const groups = await collection.aggregate([
    { $group: { _id: { affiliate: '$affiliate', product: '$product' }, count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
    { $count: 'groups' },
  ]).toArray();
  return groups[0]?.groups || 0;
}

async function validateExistingDocuments(db, collection) {
  const invalidFieldDocuments = await collection.countDocuments({
    $expr: { $or: [
      { $ne: [{ $type: '$affiliate' }, 'objectId'] },
      { $ne: [{ $type: '$product' }, 'objectId'] },
    ] },
  });
  if (invalidFieldDocuments) {
    throw new Error(`Refusing unique index creation: ${invalidFieldDocuments} documents have missing or invalid affiliate/product fields`);
  }

  const docs = await collection.find({}, { projection: { affiliate: 1, product: 1 } }).toArray();
  const affiliateIds = [...new Map(docs.map((doc) => [String(doc.affiliate), doc.affiliate])).values()];
  const productIds = [...new Map(docs.map((doc) => [String(doc.product), doc.product])).values()];
  const [affiliates, products] = await Promise.all([
    db.collection('affiliates').find({ _id: { $in: affiliateIds } }, { projection: { _id: 1 } }).toArray(),
    db.collection('merchantproducts').find({ _id: { $in: productIds } }, { projection: { _id: 1 } }).toArray(),
  ]);
  const knownAffiliateIds = new Set(affiliates.map((doc) => String(doc._id)));
  const knownProductIds = new Set(products.map((doc) => String(doc._id)));
  const danglingAffiliates = affiliateIds.filter((id) => !knownAffiliateIds.has(String(id))).length;
  const danglingProducts = productIds.filter((id) => !knownProductIds.has(String(id))).length;
  if (danglingAffiliates || danglingProducts) {
    throw new Error(`Refusing unique index creation: found ${danglingAffiliates} dangling affiliate and ${danglingProducts} dangling product references`);
  }

  const duplicateGroups = await countDuplicatePairs(collection);
  if (duplicateGroups) {
    throw new Error(`Refusing unique index creation: found ${duplicateGroups} duplicate affiliate/product groups`);
  }
}

async function provisionAffiliatePromotionIndex(db) {
  let exists = await db.listCollections({ name: COLLECTION_NAME }, { nameOnly: true }).hasNext();
  let createdCollection = false;
  if (!exists) {
    try {
      await db.createCollection(COLLECTION_NAME);
      createdCollection = true;
    } catch (error) {
      // Another provisioner may have created it after our existence check.
      if (error.code !== 48 && error.codeName !== 'NamespaceExists') throw error;
    }
    exists = await db.listCollections({ name: COLLECTION_NAME }, { nameOnly: true }).hasNext();
    if (!exists) throw new Error(`Collection ${COLLECTION_NAME} was not available after creation`);
  }

  const collection = db.collection(COLLECTION_NAME);
  const indexes = await collection.listIndexes().toArray();
  const sameName = indexes.find((index) => index.name === REQUIRED_INDEX.name);
  if (sameName) {
    if (!hasRequiredDefinition(sameName)) {
      throw new Error(`Index ${REQUIRED_INDEX.name} exists with an incompatible definition; refusing to replace it`);
    }
    return { collection: COLLECTION_NAME, createdCollection: false, createdIndex: false, index: sameName };
  }

  await validateExistingDocuments(db, collection);
  await collection.createIndex(REQUIRED_INDEX.key, { unique: true, name: REQUIRED_INDEX.name });
  return {
    collection: COLLECTION_NAME,
    createdCollection,
    createdIndex: true,
    index: { name: REQUIRED_INDEX.name, key: REQUIRED_INDEX.key, unique: true },
  };
}

async function main() {
  const uri = getLocalDevDatabaseUri();
  await mongoose.connect(uri, { maxPoolSize: 2 });
  try {
    const result = await provisionAffiliatePromotionIndex(mongoose.connection.db);
    console.log(JSON.stringify({ database: mongoose.connection.db.databaseName, ...result }, null, 2));
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`AffiliatePromotion index provisioning failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  COLLECTION_NAME,
  getLocalDevDatabaseUri,
  hasRequiredDefinition,
  provisionAffiliatePromotionIndex,
};
