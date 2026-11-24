
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  COLLECTION_NAME,
  parseArguments,
  inspectTarget,
  provision,
} = require('../scripts/provisionAffiliatePromotionProduction');

const { REQUIRED_INDEX } = require('../utils/affiliatePromotionIndexReadiness');

const TEST_URI =
  'mongodb+srv://test-user:test-password@cluster.example.net/dvepo';

function makeDatabase({
  collectionExists = false,
  indexes = [],
  invalidDocuments = 0,
  duplicateGroups = 0,
  danglingAffiliates = 0,
  danglingProducts = 0,
} = {}) {
  const state = {
    collectionExists,
    indexes: [...indexes],
    createCollectionCalls: 0,
    createIndexCalls: 0,
  };

  const collection = {
    async countDocuments() {
      return invalidDocuments;
    },

    aggregate(pipeline) {
      let count = 0;

      if (pipeline.some((stage) => stage.$group)) {
        count = duplicateGroups;
      } else if (
        pipeline.some((stage) => stage.$lookup?.from === 'affiliates')
      ) {
        count = danglingAffiliates;
      } else if (
        pipeline.some((stage) => stage.$lookup?.from === 'merchantproducts')
      ) {
        count = danglingProducts;
      }

      return {
        async toArray() {
          return count ? [{ count }] : [];
        },
      };
    },

    listIndexes() {
      return {
        async toArray() {
          return [...state.indexes];
        },
      };
    },

    async createIndex(key, options) {
      state.createIndexCalls += 1;

      state.indexes.push({
        key,
        ...options,
      });

      return options.name;
    },
  };

  const db = {
    listCollections() {
      return {
        async hasNext() {
          return state.collectionExists;
        },
      };
    },

    collection(name) {
      assert.equal(name, COLLECTION_NAME);
      return collection;
    },

    async createCollection(name) {
      assert.equal(name, COLLECTION_NAME);
      state.createCollectionCalls += 1;
      state.collectionExists = true;
      return collection;
    },
  };

  return { db, state };
}

function validIndex() {
  return {
    name: REQUIRED_INDEX.name,
    key: { affiliate: 1, product: 1 },
    unique: true,
  };
}

test('argument parsing requires an explicitly specified target', () => {
  assert.throws(
    () => parseArguments([]),
    /Both --expect-host and --expect-db are required/,
  );
});

test('argument parsing rejects execution without production confirmation', () => {
  assert.throws(
    () => parseArguments([
      '--execute',
      '--expect-host=cluster.example.net',
      '--expect-db=dvepo',
    ]),
    /requires both --execute and --confirm-production/,
  );
});

test('argument parsing rejects confirmation without execution', () => {
  assert.throws(
    () => parseArguments([
      '--confirm-production',
      '--expect-host=cluster.example.net',
      '--expect-db=dvepo',
    ]),
    /only valid together with --execute/,
  );
});

test('argument parsing accepts a dry-run target', () => {
  const options = parseArguments([
    '--expect-host=cluster.example.net',
    '--expect-db=dvepo',
  ]);

  assert.equal(options.execute, false);
  assert.equal(options.confirmProduction, false);
  assert.equal(options.expectedHost, 'cluster.example.net');
  assert.equal(options.expectedDatabase, 'dvepo');
});

test('target inspection rejects local MongoDB hosts', () => {
  const options = {
    execute: false,
    expectedHost: 'localhost',
    expectedDatabase: 'devpo',
  };

  assert.throws(
    () => inspectTarget('mongodb://localhost:27017/devpo', options),
    /refuses to connect to a local MongoDB host/,
  );
});

test('target inspection rejects an unexpected hostname', () => {
  const options = {
    execute: false,
    expectedHost: 'expected.example.net',
    expectedDatabase: 'dvepo',
  };

  assert.throws(
    () => inspectTarget(TEST_URI, options),
    /hostname does not match/,
  );
});

test('target inspection rejects an unexpected database', () => {
  const options = {
    execute: false,
    expectedHost: 'cluster.example.net',
    expectedDatabase: 'anotherdb',
  };

  assert.throws(
    () => inspectTarget(TEST_URI, options),
    /Database name does not match/,
  );
});

test('target inspection returns the verified host and database', () => {
  const options = {
    execute: false,
    expectedHost: 'cluster.example.net',
    expectedDatabase: 'dvepo',
  };

  assert.deepEqual(
    inspectTarget(TEST_URI, options),
    {
      host: 'cluster.example.net',
      database: 'dvepo',
    },
  );
});

test('execution requires NODE_ENV=production', () => {
  const previous = process.env.NODE_ENV;

  try {
    process.env.NODE_ENV = 'test';

    const options = {
      execute: true,
      expectedHost: 'cluster.example.net',
      expectedDatabase: 'dvepo',
    };

    assert.throws(
      () => inspectTarget(TEST_URI, options),
      /NODE_ENV=production/,
    );
  } finally {
    if (previous === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = previous;
    }
  }
});

test('dry-run reports missing collection and index without creating either', async () => {
  const { db, state } = makeDatabase();

  const result = await provision(db, false);

  assert.equal(result.collectionExists, false);
  assert.equal(result.createCollection, true);
  assert.equal(result.requiredIndexExists, false);
  assert.equal(result.createIndex, true);
  assert.equal(result.executed, false);

  assert.equal(state.createCollectionCalls, 0);
  assert.equal(state.createIndexCalls, 0);
  assert.equal(state.collectionExists, false);
});

test('dry-run preserves an existing collection and required index', async () => {
  const { db, state } = makeDatabase({
    collectionExists: true,
    indexes: [validIndex()],
  });

  const result = await provision(db, false);

  assert.equal(result.collectionExists, true);
  assert.equal(result.createCollection, false);
  assert.equal(result.requiredIndexExists, true);
  assert.equal(result.createIndex, false);
  assert.equal(result.executed, false);

  assert.equal(state.createCollectionCalls, 0);
  assert.equal(state.createIndexCalls, 0);
});

test('execution creates only the missing collection and required index', async () => {
  const { db, state } = makeDatabase();

  const result = await provision(db, true);

  assert.equal(state.createCollectionCalls, 1);
  assert.equal(state.createIndexCalls, 1);
  assert.equal(state.collectionExists, true);

  assert.equal(result.collectionExists, true);
  assert.equal(result.requiredIndexExists, true);
  assert.equal(result.executed, true);
  assert.equal(result.verified, true);

  assert.deepEqual(state.indexes, [validIndex()]);
});

test('execution does not recreate an existing correct index', async () => {
  const { db, state } = makeDatabase({
    collectionExists: true,
    indexes: [validIndex()],
  });

  const result = await provision(db, true);

  assert.equal(state.createCollectionCalls, 0);
  assert.equal(state.createIndexCalls, 0);
  assert.equal(result.requiredIndexExists, true);
  assert.equal(result.verified, true);
});

test('duplicate affiliate/product pairs prevent index creation', async () => {
  const { db, state } = makeDatabase({
    collectionExists: true,
    duplicateGroups: 1,
  });

  await assert.rejects(
    provision(db, true),
    /duplicate affiliate\/product groups exist/,
  );

  assert.equal(state.createCollectionCalls, 0);
  assert.equal(state.createIndexCalls, 0);
});

test('invalid affiliate/product fields prevent index creation', async () => {
  const { db, state } = makeDatabase({
    collectionExists: true,
    invalidDocuments: 2,
  });

  await assert.rejects(
    provision(db, true),
    /2 documents have missing or invalid affiliate\/product fields/,
  );

  assert.equal(state.createIndexCalls, 0);
});

test('dangling affiliate references prevent index creation', async () => {
  const { db, state } = makeDatabase({
    collectionExists: true,
    danglingAffiliates: 1,
  });

  await assert.rejects(
    provision(db, true),
    /1 dangling affiliate references/,
  );

  assert.equal(state.createIndexCalls, 0);
});

test('dangling product references prevent index creation', async () => {
  const { db, state } = makeDatabase({
    collectionExists: true,
    danglingProducts: 1,
  });

  await assert.rejects(
    provision(db, true),
    /1 dangling product references/,
  );

  assert.equal(state.createIndexCalls, 0);
});

test('incompatible index with the required name prevents provisioning', async () => {
  const { db, state } = makeDatabase({
    collectionExists: true,
    indexes: [{
      name: REQUIRED_INDEX.name,
      key: { affiliate: 1, product: 1 },
      unique: false,
    }],
  });

  await assert.rejects(
    provision(db, true),
    /incompatible definition/,
  );

  assert.equal(state.createIndexCalls, 0);
});

test('conflicting index with a different name is not replaced', async () => {
  const { db, state } = makeDatabase({
    collectionExists: true,
    indexes: [{
      name: 'existing_affiliate_product_index',
      key: { affiliate: 1, product: 1 },
      unique: false,
    }],
  });

  await assert.rejects(
    provision(db, true),
    /Manual review is required/,
  );

  assert.equal(state.createIndexCalls, 0);
});
