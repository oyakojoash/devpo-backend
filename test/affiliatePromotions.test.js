const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const AffiliatePromotion = require('../models/AffiliatePromotion');
const MerchantProduct = require('../models/MerchantProduct');
const { createAffiliatePromotionsRouter } = require('../routes/affiliatePromotions');
const { createMerchantProductsRouter } = require('../routes/merchantProducts');
const { ensureAffiliatePromotionIndex, REQUIRED_INDEX } = require('../utils/affiliatePromotionIndexReadiness');
const { createProtectAffiliate } = require('../middleware/protectAffiliate');

const AFFILIATE_A = '507f1f77bcf86cd799439011';
const AFFILIATE_B = '507f1f77bcf86cd799439012';
const MERCHANT_ID = '507f1f77bcf86cd799439013';
const PRODUCT_ID = '507f1f77bcf86cd799439014';
const ID = (value) => new mongoose.Types.ObjectId(value);

const product = () => ({
  _id: ID(PRODUCT_ID), merchant: ID(MERCHANT_ID), affiliatePromotionEnabled: true,
  model: 'retail', status: 'active', archivedAt: null, retail: { price: 1200, stock: 5 },
  name: 'Test item', description: 'Description', category: 'General', currency: 'KES', images: ['/item.jpg'],
  createdAt: new Date('2026-01-01T00:00:00Z'),
});
const merchant = () => ({ _id: ID(MERCHANT_ID), name: 'Merchant name' });
const vendor = () => ({ id: 'store-1', name: 'Store name', logo: '/logo.jpg', merchantId: MERCHANT_ID, approvalStatus: 'approved', status: 'active' });

function query(value) {
  return {
    sort() { return this; }, skip() { return this; }, limit() { return this; }, select() { return this; },
    lean: async () => value,
  };
}

function createStore({ products = [product()], promotions = [], stores = [vendor()], merchants = [merchant()] } = {}) {
  const state = { products, promotions, stores, merchants, calls: [] };
  const ProductModel = {
    find(filter) {
      state.calls.push(['products.find', filter]);
      return query(state.products.filter((item) => item.affiliatePromotionEnabled === filter.affiliatePromotionEnabled &&
        item.model === filter.model && item.status === filter.status && item.archivedAt === filter.archivedAt &&
        (item.retail?.stock || 0) > 0 && (!filter._id || String(item._id) === String(filter._id)) &&
        (!filter.merchant?.$in || filter.merchant.$in.some((id) => String(id) === String(item.merchant))) &&
        (!filter.category || item.category === filter.category) &&
        (!filter.name || new RegExp(filter.name.$regex, filter.name.$options).test(item.name))));
    },
    findOne(filter) {
      state.calls.push(['products.findOne', filter]);
      const item = state.products.find((candidate) => candidate.affiliatePromotionEnabled === filter.affiliatePromotionEnabled &&
        candidate.model === filter.model && candidate.status === filter.status && candidate.archivedAt === filter.archivedAt &&
        (candidate.retail?.stock || 0) > 0 && String(candidate._id) === String(filter._id));
      return query(item || null);
    },
    countDocuments(filter) {
      state.calls.push(['products.countDocuments', filter]);
      return Promise.resolve(state.products.filter((item) => item.affiliatePromotionEnabled && item.model === 'retail' && item.status === 'active' && item.archivedAt === null && item.retail?.stock > 0 &&
        (!filter.merchant?.$in || filter.merchant.$in.some((id) => String(id) === String(item.merchant))) &&
        (!filter.category || item.category === filter.category) &&
        (!filter.name || new RegExp(filter.name.$regex, filter.name.$options).test(item.name))).length);
    },
  };
  const AffiliatePromotionModel = {
    find(filter) {
      state.calls.push(['promotions.find', filter]);
      return query(state.promotions.filter((item) => String(item.product) === String(filter.product) && item.status === filter.status));
    },
    find(filter) {
      state.calls.push(['promotions.find', filter]);
      let records = state.promotions.filter((item) => String(item.affiliate) === String(filter.affiliate));
      if (filter.product?.$in) records = records.filter((item) => filter.product.$in.some((id) => String(id) === String(item.product)));
      return query(records);
    },
    async create(data) {
      state.calls.push(['promotions.create', data]);
      if (state.promotions.some((item) => String(item.affiliate) === String(data.affiliate) && String(item.product) === String(data.product))) {
        throw Object.assign(new Error('duplicate'), { code: 11000 });
      }
      const record = { _id: ID('507f1f77bcf86cd799439015'), ...data };
      state.promotions.push(record);
      return record;
    },
    async updateOne(filter, update) {
      const record = state.promotions.find((item) => String(item._id) === String(filter._id) && item.status === filter.status);
      if (record) Object.assign(record, update.$set);
    },
    async updateMany(filter, update) {
      state.calls.push(['promotions.updateMany', filter, update]);
      for (const record of state.promotions) if (String(record.product) === String(filter.product) && record.status === filter.status) Object.assign(record, update.$set);
    },
  };
  const MerchantModel = { find() { return query(state.merchants); } };
  const VendorModel = {
    publicMarketplaceFilter: () => ({ approvalStatus: 'approved', status: 'active' }),
    find() { return query(state.stores); },
  };
  return { state, ProductModel, AffiliatePromotionModel, MerchantModel, VendorModel };
}

function response() {
  return { statusCode: 200, body: undefined, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}

async function callRoute(router, path, method, req, res = response()) {
  const route = router.stack.find((layer) => layer.route?.path === path && layer.route.methods[method])?.route;
  assert.ok(route, `Expected ${method.toUpperCase()} ${path}`);
  for (const layer of route.stack) {
    if (res.body !== undefined) break;
    let nextCalled = false;
    let error;
    await layer.handle(req, res, (reason) => { if (reason) error = reason; else nextCalled = true; });
    if (error) throw error;
    if (!nextCalled) break;
  }
  return res;
}

function affiliateRouter(store, authenticate = (req, _res, next) => { req.affiliate = { _id: ID(AFFILIATE_A) }; next(); }) {
  return createAffiliatePromotionsRouter({
    AffiliatePromotionModel: store.AffiliatePromotionModel,
    notifyPromotionWithdrawal: async () => {},
    MerchantProductModel: store.ProductModel,
    MerchantModel: store.MerchantModel,
    VendorModel: store.VendorModel,
    protect: authenticate,
    now: () => new Date('2026-01-02T00:00:00Z'),
  });
}

test('promotion schema defaults approval off and declares the unique membership index', () => {
  const productDoc = new MerchantProduct({ name: 'Item', model: 'retail', merchant: ID(MERCHANT_ID), retail: { price: 1, stock: 1 } });
  assert.equal(productDoc.affiliatePromotionEnabled, false);
  assert.ok(AffiliatePromotion.schema.indexes().some(([keys, options]) =>
    JSON.stringify(keys) === JSON.stringify(REQUIRED_INDEX.key) && options.unique === true && options.name === REQUIRED_INDEX.name));
  assert.equal(AffiliatePromotion.schema.options.autoIndex, false);
  assert.equal(AffiliatePromotion.schema.options.autoCreate, false);
});

test('suspended affiliate sessions cannot access promotion routes', async () => {
  const protect = createProtectAffiliate({
    AffiliateSessionModel: {
      MAX_SESSION_AGE_MS: 7 * 24 * 60 * 60 * 1000,
      findOne: () => ({ select: async () => ({ _id: 'session', affiliate: AFFILIATE_A, createdAt: new Date('2026-01-01'), expiresAt: new Date('2026-01-05') }) }),
    },
    AffiliateModel: { findById: () => ({ select() { return this; }, lean: async () => ({ _id: AFFILIATE_A, status: 'suspended' }) }) },
    now: () => new Date('2026-01-02'),
  });
  const result = await callRoute(affiliateRouter(createStore(), protect), '/catalog', 'get', {
    query: {}, body: {}, cookies: { affiliateToken: 'session-token' },
  });
  assert.equal(result.statusCode, 401);
});

test('unauthenticated promotion catalogue requests are rejected', async () => {
  const store = createStore();
  const router = affiliateRouter(store, (_req, res) => res.status(401).json({ message: 'Affiliate not authenticated' }));
  const result = await callRoute(router, '/catalog', 'get', { query: {}, body: {} });
  assert.equal(result.statusCode, 401);
});

test('catalog includes eligible visible products and excludes default-unapproved products', async () => {
  const rejected = [
    { ...product(), _id: ID('507f1f77bcf86cd799439016'), affiliatePromotionEnabled: false },
    { ...product(), _id: ID('507f1f77bcf86cd799439017'), status: 'inactive' },
    { ...product(), _id: ID('507f1f77bcf86cd799439018'), archivedAt: new Date() },
    { ...product(), _id: ID('507f1f77bcf86cd799439019'), status: 'out of stock', retail: { price: 5, stock: 0 } },
  ];
  const store = createStore({ products: [product(), ...rejected] });
  const result = await callRoute(affiliateRouter(store), '/catalog', 'get', { query: {}, body: {} });
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.items.length, 1);
  assert.equal(result.body.items[0].joined, false);
  assert.equal(result.body.items[0].merchant.storeName, 'Store name');
  assert.equal(result.body.items[0].id, PRODUCT_ID);
  assert.match(result.body.items[0].id, /^[0-9a-f]{24}$/);
});

test('catalog searches names literally and matches categories exactly with filtered pagination totals', async () => {
  const matching = product();
  matching.name = 'A+B camera';
  matching.category = 'Camera';
  const categoryNearMiss = { ...product(), _id: ID('507f1f77bcf86cd799439016'), name: 'A+B lens', category: 'Camera accessories' };
  const otherCategory = { ...product(), _id: ID('507f1f77bcf86cd799439017'), name: 'A+B body', category: 'Camera body' };
  const store = createStore({ products: [matching, categoryNearMiss, otherCategory] });
  const result = await callRoute(affiliateRouter(store), '/catalog', 'get', { query: { search: 'A+B', category: 'Camera', limit: '1' }, body: {} });
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.items.length, 1);
  assert.equal(result.body.items[0].id, PRODUCT_ID);
  assert.deepEqual(result.body.pagination, { page: 1, limit: 1, total: 1, pages: 1 });
  const findFilter = store.state.calls.find((call) => call[0] === 'products.find')[1];
  const countFilter = store.state.calls.find((call) => call[0] === 'products.countDocuments')[1];
  assert.deepEqual(findFilter, countFilter);
  assert.deepEqual(findFilter.name, { $regex: 'A\\+B', $options: 'i' });
});

test('catalog rejects invalid, repeated, and overlong search/category query parameters', async () => {
  const router = affiliateRouter(createStore());
  for (const query of [
    { search: ['one', 'two'] }, { category: ['one', 'two'] }, { search: 42 },
    { search: 'x'.repeat(101) }, { category: 'x'.repeat(101) }, { unexpected: 'value' },
  ]) {
    const result = await callRoute(router, '/catalog', 'get', { query, body: {} });
    assert.equal(result.statusCode, 400, JSON.stringify(query));
  }
});

test('catalog retains store visibility restrictions when filtering', async () => {
  const hiddenStore = vendor();
  const store = createStore({ stores: [hiddenStore, { ...hiddenStore, id: 'store-2' }] });
  const result = await callRoute(affiliateRouter(store), '/catalog', 'get', { query: { search: 'Test', category: 'General' }, body: {} });
  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.body.items, []);
});

test('affiliate can join once; identity is session-derived and duplicate joins conflict', async () => {
  const store = createStore();
  const router = affiliateRouter(store);
  const first = await callRoute(router, '/', 'post', { query: {}, body: { productId: PRODUCT_ID, affiliateId: AFFILIATE_B } });
  assert.equal(first.statusCode, 400, 'client cannot submit ownership identity');
  const joined = await callRoute(router, '/', 'post', { query: {}, body: { productId: PRODUCT_ID } });
  assert.equal(joined.statusCode, 201);
  assert.equal(String(store.state.promotions[0].affiliate), AFFILIATE_A);
  const duplicate = await callRoute(router, '/', 'post', { query: {}, body: { productId: PRODUCT_ID } });
  assert.equal(duplicate.statusCode, 409);
});

test('concurrent duplicate join requests are serialized by the unique membership constraint', async () => {
  const store = createStore();
  const router = affiliateRouter(store);
  const results = await Promise.all([
    callRoute(router, '/', 'post', { query: {}, body: { productId: PRODUCT_ID } }),
    callRoute(router, '/', 'post', { query: {}, body: { productId: PRODUCT_ID } }),
  ]);
  assert.deepEqual(results.map((result) => result.statusCode).sort(), [201, 409]);
  assert.equal(store.state.promotions.length, 1);
});

test('membership listing is scoped to the authenticated affiliate', async () => {
  const store = createStore({ promotions: [
    { _id: ID('507f1f77bcf86cd799439017'), affiliate: ID(AFFILIATE_A), product: ID(PRODUCT_ID), status: 'active', joinedAt: new Date() },
    { _id: ID('507f1f77bcf86cd799439018'), affiliate: ID(AFFILIATE_B), product: ID(PRODUCT_ID), status: 'active', joinedAt: new Date() },
  ] });
  const result = await callRoute(affiliateRouter(store), '/', 'get', { query: {}, body: {} });
  assert.equal(result.body.items.length, 1);
  assert.equal(String(store.state.calls.find((call) => call[0] === 'promotions.find')[1].affiliate), AFFILIATE_A);
});

test('merchant withdrawal marks active memberships withdrawn and preserves join date', async () => {
  const store = createStore({ promotions: [{ _id: ID('507f1f77bcf86cd799439019'), affiliate: ID(AFFILIATE_A), product: ID(PRODUCT_ID), status: 'active', joinedAt: new Date('2025-12-01T00:00:00Z') }] });
  const productState = product();
  const ProductModel = {
    async findOneAndUpdate(filter, update) {
      assert.equal(String(filter.merchant), MERCHANT_ID);
      productState.affiliatePromotionEnabled = update.$set.affiliatePromotionEnabled;
      return productState;
    },
  };
  const router = createMerchantProductsRouter({
    MerchantProductModel: ProductModel,
    AffiliatePromotionModel: store.AffiliatePromotionModel,
    protect: (req, _res, next) => { req.merchant = { _id: ID(MERCHANT_ID) }; next(); },
    now: () => new Date('2026-01-03T00:00:00Z'),
  });
  const result = await callRoute(router, '/:productId/affiliate-promotion', 'patch', {
    params: { productId: PRODUCT_ID }, body: { affiliatePromotionEnabled: false }, query: {},
  });
  assert.equal(result.statusCode, 200);
  assert.equal(store.state.promotions[0].status, 'withdrawn');
  assert.equal(store.state.promotions[0].joinedAt.toISOString(), '2025-12-01T00:00:00.000Z');
  assert.equal(store.state.promotions[0].withdrawnAt.toISOString(), '2026-01-03T00:00:00.000Z');
});

test('owning merchant can enable affiliate promotion without client-supplied ownership', async () => {
  const productState = product();
  productState.affiliatePromotionEnabled = false;
  const router = createMerchantProductsRouter({
    MerchantProductModel: {
      async findOneAndUpdate(filter, update) {
        assert.equal(String(filter.merchant), MERCHANT_ID);
        productState.affiliatePromotionEnabled = update.$set.affiliatePromotionEnabled;
        return productState;
      },
    },
    AffiliatePromotionModel: { async updateMany() { assert.fail('enabling must not withdraw memberships'); } },
    protect: (req, _res, next) => { req.merchant = { _id: ID(MERCHANT_ID) }; next(); },
  });
  const result = await callRoute(router, '/:productId/affiliate-promotion', 'patch', {
    params: { productId: PRODUCT_ID }, body: { affiliatePromotionEnabled: true }, query: {},
  });
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.product.affiliatePromotionEnabled, true);
});

test('merchant cannot approve a product owned by another merchant', async () => {
  const router = createMerchantProductsRouter({
    MerchantProductModel: { async findOneAndUpdate(filter) { assert.equal(String(filter.merchant), AFFILIATE_B); return null; } },
    AffiliatePromotionModel: { async updateMany() { assert.fail('must not change memberships'); } },
    protect: (req, _res, next) => { req.merchant = { _id: ID(AFFILIATE_B) }; next(); },
  });
  const result = await callRoute(router, '/:productId/affiliate-promotion', 'patch', {
    params: { productId: PRODUCT_ID }, body: { affiliatePromotionEnabled: true }, query: {},
  });
  assert.equal(result.statusCode, 404);
});

test('affiliate membership index readiness rejects absent specifications', async () => {
  const fakeModel = {
    modelName: 'AffiliatePromotion',
    collection: { collectionName: 'affiliatepromotions' },
    db: { db: {
      listCollections: () => ({ hasNext: async () => true }),
      collection: () => ({ listIndexes: () => ({ toArray: async () => [{ name: '_id_', key: { _id: 1 } }] }) }),
    } },
  };
  await assert.rejects(ensureAffiliatePromotionIndex(fakeModel), { code: 'AFFILIATE_PROMOTION_INDEX_NOT_READY' });
});
