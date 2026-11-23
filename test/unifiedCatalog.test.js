const { test } = require('node:test');
const assert = require('node:assert/strict');
const Product = require('../models/Product');
const Vendor = require('../models/Vendor');
const MerchantProduct = require('../models/MerchantProduct');
const router = require('../routes/products');

const LEGACY_ID = '507f1f77bcf86cd799439001';
const MERCHANT_ID = '507f1f77bcf86cd799439002';
const MERCHANT_OWNER = '507f1f77bcf86cd799439003';

function request({ path = '/', params = {}, query = {} } = {}) {
  return { params, query, cookies: {}, get: () => undefined };
}

function response() {
  return {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

async function call(method, path, req) {
  const route = router.stack.find((layer) => layer.route?.path === path && layer.route.methods[method]);
  assert.ok(route, `Expected ${method.toUpperCase()} ${path}`);
  const res = response();
  for (const layer of route.route.stack) {
    let nextCalled = false;
    await layer.handle(req, res, () => { nextCalled = true; });
    if (!nextCalled || res.body !== undefined) break;
  }
  return res;
}

function makeQuery(value) {
  const query = {
    select() { return this; },
    sort() { return this; },
    skip() { return this; },
    limit() { return this; },
    lean: async () => value,
  };
  return query;
}

test('unified public catalog retains legacy IDs and exposes only unambiguous eligible merchant retail products', async (t) => {
  const originals = {
    productCount: Product.countDocuments, productFind: Product.find, productFindById: Product.findById,
    vendorFind: Vendor.find, vendorExists: Vendor.exists,
    merchantCount: MerchantProduct.countDocuments, merchantFind: MerchantProduct.find, merchantFindOne: MerchantProduct.findOne,
  };
  const vendor = { id: 'public-store', name: 'Public store', logo: '/images/logo.png', merchantId: MERCHANT_OWNER };
  const merchantProduct = {
    _id: LEGACY_ID, name: 'Merchant item', description: 'Description', category: 'Audio', model: 'retail',
    status: 'active', currency: 'KES', images: ['/images/products/not-served.jpg', 'https://cdn.example.test/item.jpg'],
    retail: { price: 1200, stock: 2 }, merchant: MERCHANT_OWNER,
  };
  let merchantFilter;
  let vendors = [vendor];
  Product.countDocuments = async () => 1;
  Product.find = () => makeQuery([{ _id: LEGACY_ID, name: 'Legacy item', price: 500, image: 'legacy.jpg', vendorId: 'public-store', description: '' }]);
  Product.findById = () => ({ lean: async () => ({ _id: LEGACY_ID, name: 'Legacy item', price: 500, image: 'legacy.jpg', vendorId: 'public-store' }) });
  Vendor.find = (filter) => filter?.merchantId
    ? { select() { return this; }, lean: async () => vendors }
    : { distinct: async () => ['public-store'] };
  Vendor.exists = async () => ({ _id: 'vendor-record' });
  MerchantProduct.countDocuments = async (filter) => { merchantFilter = filter; return 1; };
  MerchantProduct.find = () => makeQuery([merchantProduct]);
  MerchantProduct.findOne = (filter) => ({
    select() { return this; },
    lean: async () => filter._id === MERCHANT_ID ? { ...merchantProduct, _id: MERCHANT_ID } : null,
  });

  t.after(() => {
    Product.countDocuments = originals.productCount;
    Product.find = originals.productFind;
    Product.findById = originals.productFindById;
    Vendor.find = originals.vendorFind;
    Vendor.exists = originals.vendorExists;
    MerchantProduct.countDocuments = originals.merchantCount;
    MerchantProduct.find = originals.merchantFind;
    MerchantProduct.findOne = originals.merchantFindOne;
  });

  const listed = await call('get', '/', request({ query: { limit: '20' } }));
  assert.equal(listed.statusCode, 200);
  assert.equal(listed.body.totalResults, 2);
  assert.equal(listed.body.products[0]._id, LEGACY_ID);
  assert.equal(listed.body.products[1]._id, `mp_${LEGACY_ID}`);
  assert.equal(listed.body.products[0].sourceType, 'product');
  assert.equal(listed.body.products[1].sourceType, 'merchantProduct');
  assert.equal(listed.body.products[1].vendorId, 'public-store');
  assert.equal(listed.body.products[1].price, 1200);
  assert.equal(listed.body.products[1].purchasable, true);
  assert.equal(Object.hasOwn(listed.body.products[1], 'merchant'), false);
  assert.deepEqual(listed.body.products[1].images, ['https://cdn.example.test/item.jpg']);
  assert.equal(merchantFilter.model, 'retail');
  assert.equal(merchantFilter.status, 'active');
  assert.equal(merchantFilter.archivedAt, null);

  const detail = await call('get', '/:id', request({ path: '/:id', params: { id: `mp_${MERCHANT_ID}` } }));
  assert.equal(detail.statusCode, 200);
  assert.equal(detail.body._id, `mp_${MERCHANT_ID}`);
  assert.equal(detail.body.vendor.name, 'Public store');
  assert.equal(detail.body.purchasable, true);

  vendors = [vendor, { ...vendor, id: 'second-store' }];
  const ambiguous = await call('get', '/:id', request({ params: { id: `mp_${MERCHANT_ID}` } }));
  assert.equal(ambiguous.statusCode, 404);
});

test('catalog category, store, search, and pagination filters stay bounded and source scoped', async (t) => {
  const originals = {
    productCount: Product.countDocuments, productFind: Product.find, vendorFind: Vendor.find,
    merchantCount: MerchantProduct.countDocuments, merchantFind: MerchantProduct.find,
  };
  let legacyFilter;
  let merchantFilter;
  Product.countDocuments = async (filter) => { legacyFilter = filter; return 0; };
  Product.find = (filter) => { legacyFilter = filter; return makeQuery([]); };
  Vendor.find = (filter) => filter?.merchantId
    ? { select() { return this; }, lean: async () => [{ id: 'store-a', name: 'A', merchantId: MERCHANT_OWNER }] }
    : { distinct: async () => ['store-a'] };
  MerchantProduct.countDocuments = async (filter) => { merchantFilter = filter; return 0; };
  MerchantProduct.find = () => makeQuery([]);
  t.after(() => {
    Product.countDocuments = originals.productCount;
    Product.find = originals.productFind;
    Vendor.find = originals.vendorFind;
    MerchantProduct.countDocuments = originals.merchantCount;
    MerchantProduct.find = originals.merchantFind;
  });

  const res = await call('get', '/', request({ query: { search: 'headphones', category: 'Audio', storeId: 'store-a', page: '2', limit: '10' } }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(legacyFilter.vendorId, { $in: ['store-a'] });
  assert.deepEqual(legacyFilter._id, { $exists: false });
  assert.equal(merchantFilter.category, 'Audio');
  assert.deepEqual(merchantFilter.merchant, { $in: [MERCHANT_OWNER] });
  assert.equal(merchantFilter.name.$regex, 'headphones');

  await call('get', '/', request({ query: { storeId: 'unapproved-store' } }));
  assert.deepEqual(legacyFilter.vendorId, { $in: [] });
});
