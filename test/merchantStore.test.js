const { test } = require('node:test');
const assert = require('node:assert/strict');
const Vendor = require('../models/Vendor');
const productsRouter = require('../routes/products');
const { createMerchantStoreRouter, validateStoreApplication } = require('../routes/merchantStore');

const MERCHANT_ID = '507f1f77bcf86cd799439041';
const passThrough = (_req, _res, next) => next();

function makeResponse() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

async function callRoute(router, path, method, req) {
  const layer = router.stack.find((entry) => entry.route?.path === path && entry.route.methods[method]);
  assert.ok(layer, `Expected ${method.toUpperCase()} ${path}`);
  const res = makeResponse();
  for (const handler of layer.route.stack.map((entry) => entry.handle)) {
    let nextCalled = false;
    await handler(req, res, () => { nextCalled = true; });
    if (!nextCalled || res.body !== undefined) break;
  }
  return res;
}

function storeBody(extra = {}) {
  return {
    name: '  Test store  ', logo: ' logo.png ', description: '  Store description  ',
    businessName: '  Test business  ', ...extra,
  };
}

function createStoreFixture({ existing = [], reservation, failRelease = false } = {}) {
  const state = { vendors: existing.map((vendor) => ({ ...vendor })), reservation, creates: [], updates: [], failRelease };
  const VendorModel = {
    find(filter) {
      assert.deepEqual(filter, { merchantId: MERCHANT_ID });
      return { select() { return this; }, lean: async () => state.vendors.filter((vendor) => vendor.merchantId === MERCHANT_ID) };
    },
    async create(data) {
      state.creates.push(data);
      const vendor = { _id: `vendor-doc-${state.creates.length}`, ...data };
      state.vendors.push(vendor);
      return vendor;
    },
  };
  const MerchantModel = {
    findById() { return { select() { return this; }, lean: async () => null }; },
    findOneAndUpdate(filter, update) {
      const currentReservation = state.reservation;
      const available = !currentReservation || new Date(currentReservation.expiresAt) <= filter.$or[1]['vendorApplicationReservation.expiresAt'].$lte;
      const acquired = filter._id === MERCHANT_ID && available;
      if (acquired) state.reservation = update.$set.vendorApplicationReservation;
      return { select: async () => acquired ? { _id: MERCHANT_ID } : null };
    },
    async updateOne(filter, update) {
      state.updates.push({ filter, update });
      if (state.failRelease) throw new Error('simulated cleanup failure');
      if (state.reservation?.token === filter['vendorApplicationReservation.token']) state.reservation = undefined;
      return { modifiedCount: 1 };
    },
  };
  return { state, VendorModel, MerchantModel };
}

function storeRouter(fixture, protect = (req, _res, next) => {
  req.merchant = { _id: MERCHANT_ID };
  next();
}) {
  let uuid = 0;
  return createMerchantStoreRouter({
    MerchantModel: fixture.MerchantModel,
    VendorModel: fixture.VendorModel,
    protect,
    rateLimitMiddleware: passThrough,
    randomUUID: () => `uuid-${++uuid}`,
    logger: { error() {} },
  });
}

test('merchant store application uses the authenticated internal ID and existing Vendor application fields', async () => {
  const fixture = createStoreFixture();
  const router = storeRouter(fixture);
  const res = await callRoute(router, '/', 'post', { body: storeBody({ merchantId: 'forged' }) });

  assert.equal(res.statusCode, 400);
  assert.equal(fixture.state.creates.length, 0);

  const valid = await callRoute(router, '/', 'post', { body: storeBody() });
  assert.equal(valid.statusCode, 201);
  assert.equal(fixture.state.creates.length, 1);
  assert.equal(fixture.state.creates[0].merchantId, MERCHANT_ID);
  assert.equal(fixture.state.creates[0].name, 'Test store');
  assert.equal(fixture.state.creates[0].businessName, 'Test business');
  assert.equal(fixture.state.creates[0].approvalStatus, 'pending');
  assert.equal(fixture.state.creates[0].status, 'suspended');
  assert.equal(fixture.state.creates[0].id, `merchant-store-${MERCHANT_ID}`);
  assert.equal(Object.hasOwn(valid.body.vendor, 'merchantId'), false);
  assert.equal(Object.hasOwn(valid.body.vendor, '_id'), false);
  assert.equal(fixture.state.reservation, undefined);
  assert.equal(fixture.state.updates[0].filter['vendorApplicationReservation.token'], 'uuid-1');
});

test('store application validation matches Vendor profile fields and rejects malformed input', () => {
  assert.equal(validateStoreApplication(null), 'Invalid store application');
  assert.equal(validateStoreApplication({ name: 'Only a name' }), 'A valid logo is required');
  assert.equal(validateStoreApplication({ ...storeBody(), address: 42 }), 'Invalid address');
  assert.equal(validateStoreApplication(storeBody()), null);
});

test('store application requires merchant authentication and rejects forged store identities', async () => {
  const fixture = createStoreFixture();
  const unauthorizedRouter = storeRouter(fixture, (req, res, next) => {
    if (!req.authenticated) return res.status(401).json({ message: 'Merchant not authenticated' });
    req.merchant = { _id: MERCHANT_ID };
    next();
  });
  const unauthorized = await callRoute(unauthorizedRouter, '/', 'post', { body: storeBody() });
  assert.equal(unauthorized.statusCode, 401);

  const forged = await callRoute(storeRouter(fixture), '/', 'post', {
    body: storeBody({ id: 'legacy-vendor', vendorId: 'legacy-vendor', storeId: 'legacy-vendor' }),
  });
  assert.equal(forged.statusCode, 400);
  assert.equal(fixture.state.creates.length, 0);
});

test('existing association and concurrent requests cannot create a second Vendor (mocked model test)', async () => {
  const fixture = createStoreFixture({ existing: [{ _id: 'already-linked', id: 'store-old', merchantId: MERCHANT_ID }] });
  const router = storeRouter(fixture);
  const duplicate = await callRoute(router, '/', 'post', { body: storeBody() });
  assert.equal(duplicate.statusCode, 409);
  assert.equal(fixture.state.creates.length, 0);

  const concurrentFixture = createStoreFixture();
  const concurrentRouter = storeRouter(concurrentFixture);
  const results = await Promise.all([
    callRoute(concurrentRouter, '/', 'post', { body: storeBody() }),
    callRoute(concurrentRouter, '/', 'post', { body: storeBody({ name: 'Another store' }) }),
  ]);
  assert.deepEqual(results.map((result) => result.statusCode).sort(), [201, 409]);
  assert.equal(concurrentFixture.state.creates.length, 1);
  assert.equal(concurrentFixture.state.vendors.filter((vendor) => vendor.merchantId === MERCHANT_ID).length, 1);
  assert.equal(concurrentFixture.state.reservation, undefined);
});

test('expired reservations can be reclaimed (mocked model test)', async () => {
  const fixture = createStoreFixture({ reservation: { token: 'crashed-owner', expiresAt: new Date(Date.now() - 1000) } });
  const res = await callRoute(storeRouter(fixture), '/', 'post', { body: storeBody() });
  assert.equal(res.statusCode, 201);
  assert.equal(fixture.state.creates.length, 1);
  assert.equal(fixture.state.reservation, undefined);
  assert.equal(fixture.state.updates[0].filter['vendorApplicationReservation.token'], 'uuid-1');
});

test('release is conditional on reservation ownership (mocked model test)', async () => {
  const fixture = createStoreFixture();
  const originalUpdate = fixture.MerchantModel.updateOne;
  fixture.MerchantModel.updateOne = async (filter, update) => {
    fixture.state.updates.push({ filter, update });
    fixture.state.reservation = { token: 'new-owner', expiresAt: new Date(Date.now() + 60_000) };
    return { modifiedCount: 0 };
  };
  const res = await callRoute(storeRouter(fixture), '/', 'post', { body: storeBody() });
  fixture.MerchantModel.updateOne = originalUpdate;
  assert.equal(res.statusCode, 201);
  assert.equal(fixture.state.reservation.token, 'new-owner');
  assert.equal(fixture.state.updates[0].filter['vendorApplicationReservation.token'], 'uuid-1');
});

test('Vendor insert followed by reservation cleanup failure is safe to retry (mocked model test)', async () => {
  const fixture = createStoreFixture({ failRelease: true });
  const router = storeRouter(fixture);
  const first = await callRoute(router, '/', 'post', { body: storeBody() });
  assert.equal(first.statusCode, 201);
  fixture.state.failRelease = false;
  fixture.state.reservation.expiresAt = new Date(Date.now() - 1000);
  const retry = await callRoute(router, '/', 'post', { body: storeBody() });
  assert.equal(retry.statusCode, 409);
  assert.equal(fixture.state.creates.length, 1);
  assert.equal(fixture.state.vendors.length, 1);
});

test('legacy public Vendor applications remain unlinked and pending', async (t) => {
  const originalSave = Vendor.prototype.save;
  let savedVendor;
  Vendor.prototype.save = async function save() {
    savedVendor = this;
    return this;
  };
  t.after(() => { Vendor.prototype.save = originalSave; });

  const legacyRouter = require('../routes/vendors');
  const res = await callRoute(legacyRouter, '/', 'post', {
    body: { id: 'legacy-vendor', name: 'Legacy', logo: 'legacy.png', description: 'Legacy store', merchantId: MERCHANT_ID },
  });
  assert.equal(res.statusCode, 201);
  assert.equal(savedVendor.merchantId, undefined);
  assert.equal(savedVendor.approvalStatus, 'pending');
  assert.equal(savedVendor.status, 'suspended');
});

test('catalog exposes linked Merchant products only while their Vendor is publicly eligible', async (t) => {
  const Product = require('../models/Product');
  const MerchantProduct = require('../models/MerchantProduct');
  const originals = {
    productCount: Product.countDocuments,
    vendorFind: Vendor.find,
    merchantCount: MerchantProduct.countDocuments,
    merchantFind: MerchantProduct.find,
  };
  const vendor = {
    _id: 'vendor-doc', id: 'merchant-store', name: 'Merchant store', logo: 'logo.png',
    merchantId: MERCHANT_ID, approvalStatus: 'pending', status: 'suspended',
  };
  const merchantProduct = {
    _id: '507f1f77bcf86cd799439051', name: 'Retail item', description: '', category: 'General',
    model: 'retail', status: 'active', currency: 'KES', images: [], retail: { price: 50, stock: 2 },
    merchant: MERCHANT_ID,
  };
  Product.countDocuments = async () => 0;
  Vendor.find = (filter) => {
    if (filter?.$or) {
      const visible = (vendor.approvalStatus === 'approved' && vendor.status === 'active') ||
        (vendor.approvalStatus === undefined && vendor.status === undefined);
      return { distinct: async () => visible ? [vendor.id] : [] };
    }
    return { select() { return this; }, lean: async () => [vendor] };
  };
  MerchantProduct.countDocuments = async () => 1;
  MerchantProduct.find = () => ({
    select() { return this; }, sort() { return this; }, skip() { return this; }, limit() { return this; },
    lean: async () => [merchantProduct],
  });
  t.after(() => {
    Product.countDocuments = originals.productCount;
    Vendor.find = originals.vendorFind;
    MerchantProduct.countDocuments = originals.merchantCount;
    MerchantProduct.find = originals.merchantFind;
  });

  const router = productsRouter;
  const hidden = await callRoute(router, '/', 'get', { query: {}, cookies: {}, get: () => undefined });
  assert.equal(hidden.body.totalResults, 0);

  vendor.approvalStatus = 'approved';
  vendor.status = 'active';
  const visible = await callRoute(router, '/', 'get', { query: {}, cookies: {}, get: () => undefined });
  assert.equal(visible.body.totalResults, 1);
  assert.equal(visible.body.products[0]._id, `mp_${merchantProduct._id}`);

  vendor.status = 'suspended';
  const suspended = await callRoute(router, '/', 'get', { query: {}, cookies: {}, get: () => undefined });
  assert.equal(suspended.body.totalResults, 0);
});
