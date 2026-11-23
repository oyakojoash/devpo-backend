const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  COLLECTION_NAME,
  hasRequiredDefinition,
  provisionAffiliatePromotionIndex,
} = require('../scripts/migrateAffiliatePromotionIndex');

function makeDatabase({ exists = false, documents = [], indexes = [], duplicateGroups = 0, invalidDocuments = 0 } = {}) {
  const state = { exists, documents, indexes: [...indexes], createCollectionCalls: 0, createIndexCalls: 0 };
  const collection = {
    listIndexes() { return { toArray: async () => state.indexes }; },
    async countDocuments() { return invalidDocuments; },
    find() { return { toArray: async () => state.documents }; },
    aggregate() { return { toArray: async () => (duplicateGroups ? [{ groups: duplicateGroups }] : []) }; },
    async createIndex(key, options) {
      state.createIndexCalls += 1;
      const index = { key, ...options };
      state.indexes.push(index);
      return options.name;
    },
  };
  const db = {
    listCollections(filter) {
      assert.deepEqual(filter, { name: COLLECTION_NAME });
      return { hasNext: async () => state.exists };
    },
    async createCollection(name) {
      assert.equal(name, COLLECTION_NAME);
      state.createCollectionCalls += 1;
      state.exists = true;
      return collection;
    },
    collection(name) {
      if (name !== COLLECTION_NAME) {
        assert.ok(['affiliates', 'merchantproducts'].includes(name));
        return { find: () => ({ toArray: async () => documents.map((doc) => ({ _id: name === 'affiliates' ? doc.affiliate : doc.product })) }) };
      }
      return collection;
    },
  };
  return { db, state };
}

const correctIndex = {
  name: 'uniq_affiliate_product_promotion',
  key: { affiliate: 1, product: 1 },
  unique: true,
};

test('missing collection and index are provisioned explicitly with the required definition', async () => {
  const { db, state } = makeDatabase();
  const result = await provisionAffiliatePromotionIndex(db);
  assert.equal(result.createdCollection, true);
  assert.equal(result.createdIndex, true);
  assert.equal(state.createCollectionCalls, 1);
  assert.deepEqual(state.indexes[0], correctIndex);
});

test('existing collection documents remain preserved while the index is added', async () => {
  const documents = [{ affiliate: 'a', product: 'p' }];
  const { db, state } = makeDatabase({ exists: true, documents });
  const result = await provisionAffiliatePromotionIndex(db);
  assert.equal(result.createdCollection, false);
  assert.equal(result.createdIndex, true);
  assert.strictEqual(state.documents, documents);
  assert.equal(state.createCollectionCalls, 0);
});

test('an existing exact index is accepted without recreating it', async () => {
  assert.equal(hasRequiredDefinition(correctIndex), true);
  const { db, state } = makeDatabase({ exists: true, indexes: [correctIndex] });
  const result = await provisionAffiliatePromotionIndex(db);
  assert.equal(result.createdIndex, false);
  assert.equal(state.createIndexCalls, 0);
});

test('repeated provisioning is idempotent', async () => {
  const { db, state } = makeDatabase();
  await provisionAffiliatePromotionIndex(db);
  const result = await provisionAffiliatePromotionIndex(db);
  assert.equal(result.createdCollection, false);
  assert.equal(result.createdIndex, false);
  assert.equal(state.createCollectionCalls, 1);
  assert.equal(state.createIndexCalls, 1);
});

test('same-name incompatible index fails without dropping or replacing it', async () => {
  const incompatible = { name: correctIndex.name, key: { product: 1, affiliate: 1 }, unique: true };
  const { db, state } = makeDatabase({ exists: true, indexes: [incompatible] });
  await assert.rejects(provisionAffiliatePromotionIndex(db), /incompatible definition/);
  assert.deepEqual(state.indexes, [incompatible]);
  assert.equal(state.createIndexCalls, 0);
});

test('duplicate affiliate/product groups stop index creation', async () => {
  const { db, state } = makeDatabase({ exists: true, duplicateGroups: 2 });
  await assert.rejects(provisionAffiliatePromotionIndex(db), /found 2 duplicate affiliate\/product groups/);
  assert.equal(state.createIndexCalls, 0);
});

test('documents with missing or invalid references stop index creation', async () => {
  const { db, state } = makeDatabase({ exists: true, invalidDocuments: 1 });
  await assert.rejects(provisionAffiliatePromotionIndex(db), /missing or invalid affiliate\/product fields/);
  assert.equal(state.createIndexCalls, 0);
});
