const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const MerchantProduct = require('../models/MerchantProduct');
const { createMerchantProductsRouter, validateModelNumbers } = require('../routes/merchantProducts');

const MERCHANT_A = '507f1f77bcf86cd799439011';
const MERCHANT_B = '507f1f77bcf86cd799439012';
const PRODUCT_A = '507f1f77bcf86cd799439021';
const PRODUCT_B = '507f1f77bcf86cd799439022';

const validRetail = () => ({ model: 'retail', name: 'Headphones', retail: { price: 2500, stock: 3 } });
const validWholesale = () => ({
  model: 'wholesale', name: 'Shirts',
  wholesale: { unitPrice: 350, minimumOrderQuantity: 10, stock: 500, unitsPerPackage: 5, bulkPricing: [{ minimumQuantity: 50, unitPrice: 300 }] },
});
const validSubscription = () => ({
  model: 'subscription', name: 'Digital access',
  subscription: { price: 500, billingInterval: 'month', duration: 12, autoRenew: true, benefits: 'Premium access' },
});

function plain(value) {
  if (value?.toObject) return value.toObject();
  return structuredClone(value);
}

function matches(item, filter) {
  return Object.entries(filter).every(([key, expected]) => {
    if (key === '$or') return expected.some((branch) => matches(item, branch));
    const actual = key.split('.').reduce((value, part) => value?.[part], item);
    if (expected instanceof RegExp) return expected.test(String(actual ?? ''));
    if (expected === null) return actual === null || actual === undefined;
    return String(actual) === String(expected);
  });
}

function createMemoryModel(seed = []) {
  const records = seed.map(plain);
  const calls = { aggregate: [], findOne: [], findOneAndUpdate: [], countDocuments: [] };
  let nextId = 30;

  class MemoryDocument {
    constructor(data) {
      Object.assign(this, plain(data));
      this._id = this._id || `507f1f77bcf86cd7994390${String(nextId++).padStart(2, '0')}`;
      this.createdAt = this.createdAt || new Date('2026-01-01T00:00:00.000Z');
      this.updatedAt = this.updatedAt || this.createdAt;
      this.archivedAt = this.archivedAt ?? null;
    }
    toObject() { return plain(Object.fromEntries(Object.entries(this).filter(([key]) => !key.startsWith('$')))); }
    async validate() { return this; }
    set(key, value) {
      if (typeof key === 'string') this[key] = plain(value);
      else Object.assign(this, plain(key));
    }
    async save() {
      this.updatedAt = new Date('2026-01-02T00:00:00.000Z');
      const index = records.findIndex((record) => record._id === this._id);
      if (index < 0) records.push(this.toObject());
      else records[index] = this.toObject();
      return this;
    }
  }

  class Query {
    constructor(value) { this.value = value; }
    select() { return this; }
    lean() { return Promise.resolve(this.value ? plain(this.value) : null); }
    then(resolve, reject) { return Promise.resolve(this.value).then(resolve, reject); }
  }

  MemoryDocument.records = records;
  MemoryDocument.calls = calls;
  MemoryDocument.aggregate = async (pipeline) => {
    calls.aggregate.push(pipeline);
    const filter = pipeline[0].$match;
    const rows = records.filter((record) => matches(record, filter)).map((record) => ({
      ...plain(record),
      _merchantSortPrice: record.retail?.price ?? record.wholesale?.unitPrice ?? record.subscription?.price,
      _merchantSortStock: record.retail?.stock ?? record.wholesale?.stock,
    }));
    const sort = pipeline.find((stage) => stage.$sort)?.$sort || {};
    rows.sort((left, right) => {
      for (const [field, direction] of Object.entries(sort)) {
        const a = field.split('.').reduce((value, part) => value?.[part], left);
        const b = field.split('.').reduce((value, part) => value?.[part], right);
        if (a === b) continue;
        if (a == null) return -direction;
        if (b == null) return direction;
        return (a < b ? -1 : 1) * direction;
      }
      return 0;
    });
    const skip = pipeline.find((stage) => stage.$skip)?.$skip || 0;
    const limit = pipeline.find((stage) => stage.$limit)?.$limit;
    return rows.slice(skip, skip + limit).map(({ _merchantSortPrice, _merchantSortStock, ...row }) => row);
  };
  MemoryDocument.countDocuments = async (filter) => {
    calls.countDocuments.push(filter);
    return records.filter((record) => matches(record, filter)).length;
  };
  MemoryDocument.findOne = (filter) => {
    calls.findOne.push(filter);
    const record = records.find((item) => matches(item, filter));
    return new Query(record ? new MemoryDocument(record) : null);
  };
  MemoryDocument.findOneAndUpdate = async (filter, update) => {
    calls.findOneAndUpdate.push({ filter, update });
    const record = records.find((item) => matches(item, filter));
    if (!record) return null;
    for (const [key, value] of Object.entries(update.$set || {})) {
      const parts = key.split('.');
      const leaf = parts.pop();
      const parent = parts.reduce((target, part) => (target[part] ||= {}), record);
      parent[leaf] = value;
    }
    return new MemoryDocument(record);
  };
  return MemoryDocument;
}

function response() {
  return {
    statusCode: 200, body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
  };
}

function makeRequest({ merchant = MERCHANT_A, params = {}, query = {}, body = {}, method = 'GET' } = {}) {
  return {
    merchant, params, query, body, method, headers: {}, cookies: {},
    get(name) { return this.headers[name.toLowerCase()]; },
  };
}

async function callRoute(router, routePath, method, req) {
  const res = response();
  const layer = router.stack.find((item) => item.route?.path === routePath && item.route.methods[method]);
  assert.ok(layer, `Expected ${method.toUpperCase()} ${routePath}`);
  let forwardedError;
  const handlers = layer.route.stack.map((item) => item.handle);
  for (const handler of handlers) {
    let nextCalled = false;
    let nextPromise;
    await handler(req, res, (error) => {
      if (error) forwardedError = error;
      else { nextCalled = true; nextPromise = Promise.resolve(); }
    });
    if (forwardedError) throw forwardedError;
    if (!nextCalled || res.body !== undefined) break;
    await nextPromise;
  }
  return res;
}

function fixtureProduct({ _id = PRODUCT_A, merchant = MERCHANT_A, ...data } = {}) {
  return {
    _id, merchant, name: 'Headphones', description: '', productClass: '', category: '', sku: '',
    model: 'retail', status: 'active', currency: 'KES', images: [], retail: { price: 2500, stock: 3 },
    wholesale: undefined, subscription: undefined, createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'), archivedAt: null, ...data,
  };
}

test('MerchantProduct validates retail, wholesale, and subscription shapes without a database', async () => {
  const merchant = new mongoose.Types.ObjectId(MERCHANT_A);
  for (const input of [validRetail(), validWholesale(), validSubscription()]) {
    const product = new MerchantProduct({ ...input, merchant });
    await assert.doesNotReject(product.validate());
    assert.equal(product.currency, 'KES');
  }
  assert.equal(MerchantProduct.schema.options.timestamps, true);
});

test('MerchantProduct rejects invalid model fields, status, numeric values, and image references', async (t) => {
  const cases = [
    ['missing retail object', { model: 'retail', name: 'Missing' }],
    ['incompatible object', { ...validRetail(), wholesale: { unitPrice: 4, minimumOrderQuantity: 1, stock: 0 } }],
    ['zero price', { ...validRetail(), retail: { price: 0, stock: 0 } }],
    ['infinite price', { ...validRetail(), retail: { price: Infinity, stock: 0 } }],
    ['negative stock', { ...validRetail(), retail: { price: 1, stock: -1 } }],
    ['fractional stock', { ...validRetail(), retail: { price: 1, stock: 1.5 } }],
    ['unsafe retail stock', { ...validRetail(), retail: { price: 1, stock: Number.MAX_SAFE_INTEGER + 1 } }],
    ['invalid wholesale minimum', { ...validWholesale(), wholesale: { ...validWholesale().wholesale, minimumOrderQuantity: 0 } }],
    ['unsafe wholesale minimum', { ...validWholesale(), wholesale: { ...validWholesale().wholesale, minimumOrderQuantity: Number.MAX_SAFE_INTEGER + 1 } }],
    ['unsafe wholesale stock', { ...validWholesale(), wholesale: { ...validWholesale().wholesale, stock: Number.MAX_SAFE_INTEGER + 1 } }],
    ['invalid package count', { ...validWholesale(), wholesale: { ...validWholesale().wholesale, unitsPerPackage: 0 } }],
    ['unsafe package count', { ...validWholesale(), wholesale: { ...validWholesale().wholesale, unitsPerPackage: Number.MAX_SAFE_INTEGER + 1 } }],
    ['invalid bulk tier', { ...validWholesale(), wholesale: { ...validWholesale().wholesale, bulkPricing: [{ minimumQuantity: 0, unitPrice: 10 }] } }],
    ['unsafe bulk minimum quantity', { ...validWholesale(), wholesale: { ...validWholesale().wholesale, bulkPricing: [{ minimumQuantity: Number.MAX_SAFE_INTEGER + 1, unitPrice: 10 }] } }],
    ['invalid interval', { ...validSubscription(), subscription: { ...validSubscription().subscription, billingInterval: 'quarter' } }],
    ['invalid duration', { ...validSubscription(), subscription: { ...validSubscription().subscription, duration: 0 } }],
    ['unsafe subscription duration', { ...validSubscription(), subscription: { ...validSubscription().subscription, duration: Number.MAX_SAFE_INTEGER + 1 } }],
    ['missing auto renew', { ...validSubscription(), subscription: { price: 5, billingInterval: 'month', duration: 1 } }],
    ['invalid status', { ...validRetail(), status: 'published' }],
    ['data URL image', { ...validRetail(), images: ['data:image/png;base64,AAAA'] }],
    ['invalid image scheme', { ...validRetail(), images: ['javascript:alert(1)'] }],
  ];
  for (const [name, input] of cases) await t.test(name, async () => {
    const product = new MerchantProduct({ ...input, merchant: new mongoose.Types.ObjectId(MERCHANT_A) });
    await assert.rejects(product.validate());
  });
});

test('Merchant product route validation rejects unsafe integers for all integer fields', () => {
  const unsafe = Number.MAX_SAFE_INTEGER + 1;
  const cases = [
    ['retail', { price: 1, stock: unsafe }],
    ['wholesale', { unitPrice: 1, minimumOrderQuantity: unsafe, stock: 0 }],
    ['wholesale', { unitPrice: 1, minimumOrderQuantity: 1, stock: unsafe }],
    ['wholesale', { unitPrice: 1, minimumOrderQuantity: 1, stock: 0, unitsPerPackage: unsafe }],
    ['wholesale', { unitPrice: 1, minimumOrderQuantity: 1, stock: 0, bulkPricing: [{ minimumQuantity: unsafe, unitPrice: 1 }] }],
    ['subscription', { price: 1, billingInterval: 'month', duration: unsafe, autoRenew: false }],
  ];
  for (const [model, data] of cases) {
    assert.notEqual(validateModelNumbers(model, data, { creating: true }), null, `${model}: ${JSON.stringify(data)}`);
  }
});

test('MerchantProduct declares no SKU uniqueness and indexes Merchant-scoped listings', () => {
  const indexes = MerchantProduct.schema.indexes();
  assert.equal(indexes.some(([fields, options]) => fields.sku && options.unique), false);
  assert.equal(indexes.some(([fields]) => fields.merchant === 1 && fields.createdAt === -1), true);
  assert.equal(indexes.some(([fields]) => fields.merchant === 1 && fields.model === 1 && fields.status === 1), true);
});

test('all Merchant product operations use the authenticated internal Merchant ID', async (t) => {
  const rows = [
    fixtureProduct(),
    fixtureProduct({ _id: PRODUCT_B, merchant: MERCHANT_B, name: 'Other merchant item' }),
  ];
  const Model = createMemoryModel(rows);
  const router = createMerchantProductsRouter({
    MerchantProductModel: Model,
    protect: (req, _res, next) => { req.merchant = { _id: MERCHANT_A, merchantId: '99999' }; next(); },
    now: () => new Date('2026-02-01T00:00:00.000Z'),
  });

  const created = await callRoute(router, '/', 'post', makeRequest({ method: 'POST', body: validRetail() }));
  assert.equal(created.statusCode, 201);
  assert.equal(Model.records.at(-1).merchant, MERCHANT_A);
  assert.equal(created.body.product.merchant, undefined);
  assert.match(created.body.product.id, /^[0-9a-f]{24}$/);
  assert.equal(created.body.product.currency, 'KES');

  const read = await callRoute(router, '/:productId', 'get', makeRequest({ params: { productId: PRODUCT_A } }));
  assert.equal(read.statusCode, 200);
  assert.equal(read.body.product.name, 'Headphones');
  assert.equal(Model.calls.findOne.at(-1).merchant, MERCHANT_A);

  await t.test('client owner and server fields are rejected', async () => {
    for (const field of ['merchant', 'merchantId', 'id', '_id', 'createdAt', 'updatedAt', 'storeId']) {
      const invalid = await callRoute(router, '/', 'post', makeRequest({ body: { ...validRetail(), [field]: MERCHANT_B } }));
      assert.equal(invalid.statusCode, 400, field);
    }
  });

  await t.test('other Merchant cannot read, edit, adjust inventory, or archive a product', async () => {
    assert.equal((await callRoute(router, '/:productId', 'get', makeRequest({ params: { productId: PRODUCT_B } }))).statusCode, 404);
    assert.equal((await callRoute(router, '/:productId', 'patch', makeRequest({ params: { productId: PRODUCT_B }, method: 'PATCH', body: { name: 'Stolen' } }))).statusCode, 404);
    assert.equal((await callRoute(router, '/:productId/inventory', 'patch', makeRequest({ params: { productId: PRODUCT_B }, method: 'PATCH', body: { stock: 1 } }))).statusCode, 404);
    assert.equal((await callRoute(router, '/:productId', 'delete', makeRequest({ params: { productId: PRODUCT_B }, method: 'DELETE' }))).statusCode, 404);
    assert.equal(Model.records.find((item) => item._id === PRODUCT_B).name, 'Other merchant item');
  });

  await t.test('product model changes are rejected', async () => {
    const result = await callRoute(router, '/:productId', 'patch', makeRequest({
      method: 'PATCH', params: { productId: PRODUCT_A }, body: { model: 'wholesale' },
    }));
    assert.equal(result.statusCode, 400);
    assert.equal(Model.records.find((item) => item._id === PRODUCT_A).model, 'retail');
  });

  await t.test('legitimate edit retains ownership and model', async () => {
    const result = await callRoute(router, '/:productId', 'patch', makeRequest({
      method: 'PATCH', params: { productId: PRODUCT_A }, body: { name: 'Updated headphones', retail: { price: 2700 } },
    }));
    assert.equal(result.statusCode, 200);
    assert.equal(result.body.product.name, 'Updated headphones');
    assert.equal(result.body.product.retail.price, 2700);
    assert.equal(Model.records.find((item) => item._id === PRODUCT_A).merchant, MERCHANT_A);
  });
});

test('list filters, search, sorting, pagination, and archived visibility are bounded and owner-scoped', async () => {
  const Model = createMemoryModel([
    fixtureProduct({ category: 'Audio' }),
    fixtureProduct({ _id: PRODUCT_B, name: 'Archived headphones', category: 'Audio', archivedAt: new Date('2026-01-03T00:00:00Z') }),
    fixtureProduct({ _id: '507f1f77bcf86cd799439023', merchant: MERCHANT_B, name: 'Other owner headphones' }),
  ]);
  const router = createMerchantProductsRouter({
    MerchantProductModel: Model,
    protect: (req, _res, next) => { req.merchant = { _id: MERCHANT_A }; next(); },
  });
  const res = await callRoute(router, '/', 'get', makeRequest({ query: { q: 'headphones', model: 'retail', status: 'active', category: 'Audio', sort: 'price', page: '2', limit: '1' } }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.pagination, { page: 2, limit: 1, total: 1, pages: 1 });
  assert.equal(res.body.items.length, 0);
  const filter = Model.calls.aggregate.at(-1)[0].$match;
  assert.equal(filter.merchant, MERCHANT_A);
  assert.equal(filter.archivedAt, null);
  assert.equal(filter.model, 'retail');
  assert.ok(filter.$or.some((clause) => clause.name));

  const archived = await callRoute(router, '/', 'get', makeRequest({ query: { includeArchived: 'true' } }));
  assert.equal(archived.body.pagination.total, 2);
  assert.equal(archived.body.items.length, 2);

  for (const query of [{ page: '0' }, { limit: '51' }, { sort: 'random' }, { model: 'vendor' }, { status: 'published' }, { includeArchived: 'yes' }, { extra: 'x' }]) {
    assert.equal((await callRoute(router, '/', 'get', makeRequest({ query }))).statusCode, 400);
  }
});

test('inventory updates are atomic, owner-scoped, and unavailable for subscriptions', async (t) => {
  const subscriptionId = '507f1f77bcf86cd799439024';
  const Model = createMemoryModel([
    fixtureProduct(),
    fixtureProduct({ _id: subscriptionId, model: 'subscription', retail: undefined, subscription: validSubscription().subscription }),
  ]);
  const router = createMerchantProductsRouter({
    MerchantProductModel: Model,
    protect: (req, _res, next) => { req.merchant = { _id: MERCHANT_A }; next(); },
  });

  const updated = await callRoute(router, '/:productId/inventory', 'patch', makeRequest({
    method: 'PATCH', params: { productId: PRODUCT_A }, body: { stock: 0 },
  }));
  assert.equal(updated.statusCode, 200);
  assert.equal(updated.body.product.retail.stock, 0);
  assert.deepEqual(Model.calls.findOneAndUpdate.at(-1).filter, {
    _id: PRODUCT_A, merchant: MERCHANT_A, archivedAt: null, model: 'retail',
  });

  assert.equal((await callRoute(router, '/:productId/inventory', 'patch', makeRequest({
    method: 'PATCH', params: { productId: subscriptionId }, body: { stock: 1 },
  }))).statusCode, 400);
  for (const stock of [-1, 1.5, '2', Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal((await callRoute(router, '/:productId/inventory', 'patch', makeRequest({
      method: 'PATCH', params: { productId: PRODUCT_A }, body: { stock },
    }))).statusCode, 400);
  }
  await t.test('inventory response does not imply order reservation or oversell protection', () => {
    assert.equal(updated.body.product.retail.stock, 0);
  });
});

test('delete archives products, default lists hide them, and normal updates cannot reactivate them', async () => {
  const Model = createMemoryModel([fixtureProduct()]);
  const router = createMerchantProductsRouter({
    MerchantProductModel: Model,
    protect: (req, _res, next) => { req.merchant = { _id: MERCHANT_A }; next(); },
    now: () => new Date('2026-03-01T00:00:00.000Z'),
  });
  const deleted = await callRoute(router, '/:productId', 'delete', makeRequest({ method: 'DELETE', params: { productId: PRODUCT_A } }));
  assert.equal(deleted.statusCode, 200);
  assert.equal(deleted.body.archived, true);
  assert.equal(Model.records[0].archivedAt.toISOString(), '2026-03-01T00:00:00.000Z');
  assert.equal(Model.records[0].status, 'active');
  const hidden = await callRoute(router, '/', 'get', makeRequest());
  assert.equal(hidden.body.pagination.total, 0);
  const visible = await callRoute(router, '/', 'get', makeRequest({ query: { includeArchived: 'true' } }));
  assert.equal(visible.body.pagination.total, 1);
  const attemptedUpdate = await callRoute(router, '/:productId', 'patch', makeRequest({
    method: 'PATCH', params: { productId: PRODUCT_A }, body: { status: 'active' },
  }));
  assert.equal(attemptedUpdate.statusCode, 404);
});

test('image references accept safe paths and HTTP URLs but reject data URLs and object payloads', async () => {
  const Model = createMemoryModel();
  const router = createMerchantProductsRouter({
    MerchantProductModel: Model,
    protect: (req, _res, next) => { req.merchant = { _id: MERCHANT_A }; next(); },
  });
  for (const images of [['/images/products/item.jpg'], ['https://cdn.example.test/item.jpg']]) {
    const result = await callRoute(router, '/', 'post', makeRequest({ method: 'POST', body: { ...validRetail(), images } }));
    assert.equal(result.statusCode, 201);
  }
  for (const images of [['data:image/jpeg;base64,AAAA'], [{ src: '/images/item.jpg' }], ['javascript:alert(1)']]) {
    const result = await callRoute(router, '/', 'post', makeRequest({ method: 'POST', body: { ...validRetail(), images } }));
    assert.equal(result.statusCode, 400);
  }
});
