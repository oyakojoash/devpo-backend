const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = 'unit-test-secret-that-is-at-least-thirty-two-characters';
const jwt = require('jsonwebtoken');
const Admin = require('../models/adminmodels');
const Product = require('../models/Product');
const Vendor = require('../models/Vendor');
const Order = require('../models/Order');
const productsRouter = require('../routes/products');
const adminRouter = require('../routes/admin');

const adminId = '507f1f77bcf86cd799439011';
const productId = '507f1f77bcf86cd799439012';
const orderId = '507f1f77bcf86cd799439013';
const tokenFor = (role = 'admin') => jwt.sign({ id: adminId, role }, process.env.JWT_SECRET, { algorithm: 'HS256' });

function makeRequest({ origin, token, params = {}, query = {}, body = {} } = {}) {
  return {
    cookies: token ? { adminToken: token } : {},
    params,
    query,
    body,
    get(name) { return name.toLowerCase() === 'origin' ? origin : undefined; },
  };
}

function makeResponse() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

async function callRoute(router, routePath, req, { method = 'get', skipIndexes = [] } = {}) {
  const layer = router.stack.find((entry) => entry.route?.path === routePath && entry.route.methods[method]);
  assert.ok(layer, 'Expected route ' + routePath);
  const handlers = layer.route.stack.map((entry) => entry.handle);
  const res = makeResponse();
  const skipped = new Set(skipIndexes);
  const dispatch = async (index, error) => {
    if (error) throw error;
    if (index >= handlers.length) return;
    if (skipped.has(index)) return dispatch(index + 1);
    if (typeof handlers[index].run === 'function' && handlers[index].builder) {
      await handlers[index].run(req);
      return dispatch(index + 1);
    }
    return handlers[index](req, res, (nextError) => dispatch(index + 1, nextError));
  };
  await dispatch(0);
  return res;
}

test('admin auth, catalog visibility, and order detail API contracts', async (t) => {
  const originals = {
    adminFindById: Admin.findById,
    productCountDocuments: Product.countDocuments,
    productFind: Product.find,
    productFindById: Product.findById,
    vendorFind: Vendor.find,
    vendorExists: Vendor.exists,
    orderFindById: Order.findById,
  };
  let adminRole = 'admin';
  let observedFilters = [];
  Admin.findById = (id) => ({
    select() { return { lean: async () => ({ _id: id, role: adminRole }) }; },
  });

  try {
    await t.test('requires an admin session for protected routes', async () => {
      const res = await callRoute(adminRouter, '/me', makeRequest());
      assert.equal(res.statusCode, 401);
    });

    await t.test('rejects a session when the stored admin role was removed', async () => {
      adminRole = 'user';
      const res = await callRoute(adminRouter, '/me', makeRequest({ token: tokenFor() }));
      assert.equal(res.statusCode, 403);
      adminRole = 'admin';
    });

    await t.test('keeps public catalog reads scoped to marketplace vendors', async () => {
      observedFilters = [];
      Vendor.find = (filter) => filter?.merchantId
        ? { select() { return this; }, lean: async () => [] }
        : { distinct: async () => ['public-vendor'] };
      Product.countDocuments = async (filter) => { observedFilters.push(filter); return 0; };
      Product.find = (filter) => {
        observedFilters.push(filter);
        return { select() { return this; }, skip() { return this; }, limit() { return this; }, lean: async () => [] };
      };
      const res = await callRoute(productsRouter, '/', makeRequest({ origin: 'https://dvepo.netlify.app' }));
      assert.equal(res.statusCode, 200);
      assert.deepEqual(observedFilters[0].vendorId, { $in: ['public-vendor'] });
    });

    await t.test('keeps customer-origin catalog reads scoped even with an admin cookie', async () => {
      observedFilters = [];
      const res = await callRoute(productsRouter, '/', makeRequest({
        origin: 'https://dvepo.netlify.app', token: tokenFor(),
      }));
      assert.equal(res.statusCode, 200);
      assert.deepEqual(observedFilters[0].vendorId, { $in: ['public-vendor'] });
    });

    await t.test('expands product reads only for a valid admin session from the admin origin', async () => {
      observedFilters = [];
      const res = await callRoute(productsRouter, '/', makeRequest({
        origin: 'https://dvepoadmin.netlify.app', token: tokenFor(),
      }));
      assert.equal(res.statusCode, 200);
      assert.equal(observedFilters.every((filter) => filter.vendorId === undefined), true);
    });

    await t.test('returns hidden product details to an admin but not public callers', async () => {
      Product.findById = () => ({ lean: async () => ({ _id: productId, name: 'Pending vendor item', vendorId: 'pending-vendor' }) });
      Vendor.exists = async () => null;
      const adminRes = await callRoute(productsRouter, '/:id', makeRequest({
        origin: 'http://localhost:3000', token: tokenFor(), params: { id: productId },
      }));
      const publicRes = await callRoute(productsRouter, '/:id', makeRequest({ params: { id: productId } }));
      assert.equal(adminRes.statusCode, 200);
      assert.equal(publicRes.statusCode, 404);
    });

    await t.test('maps customer fullName and contact data to the admin order response', async () => {
      const order = {
        toObject: () => ({
          _id: orderId,
          user: { fullName: 'Customer Name', email: 'customer@example.test', phone: '555-0100' },
          userInfo: {},
          products: [],
        }),
      };
      Order.findById = () => ({ populate() { return this; }, then(resolve, reject) { return Promise.resolve(order).then(resolve, reject); } });
      const res = await callRoute(adminRouter, '/orders/:id', makeRequest({
        token: tokenFor(), params: { id: orderId },
      }));
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.user.name, 'Customer Name');
      assert.equal(res.body.userInfo.phone, '555-0100');
    });
  } finally {
    Admin.findById = originals.adminFindById;
    Product.countDocuments = originals.productCountDocuments;
    Product.find = originals.productFind;
    Product.findById = originals.productFindById;
    Vendor.find = originals.vendorFind;
    Vendor.exists = originals.vendorExists;
    Order.findById = originals.orderFindById;
  }
});

test('product pagination, creation, and vendor reassignment validate inputs before writes', async (t) => {
  const originals = {
    adminFindById: Admin.findById,
    productCountDocuments: Product.countDocuments,
    productFind: Product.find,
    productCreate: Product.create,
    productFindByIdAndUpdate: Product.findByIdAndUpdate,
    vendorFind: Vendor.find,
    vendorExists: Vendor.exists,
  };
  const observed = { vendorReads: 0, creates: [], updates: [], pagination: null };
  Admin.findById = (id) => ({
    select() { return { lean: async () => ({ _id: id, role: 'admin' }) }; },
  });
  Vendor.find = (filter) => filter?.merchantId
    ? { select() { return this; }, lean: async () => [] }
    : { distinct: async () => ['vendor-a'] };
  Vendor.exists = async ({ id }) => {
    observed.vendorReads += 1;
    return id === 'vendor-a' ? { _id: 'vendor-document-id' } : null;
  };
  Product.countDocuments = async () => 1;
  Product.find = () => ({
    select() { return this; },
    sort() { return this; },
    skip(value) { observed.pagination = { ...observed.pagination, skip: value }; return this; },
    limit(value) { observed.pagination = { ...observed.pagination, limit: value }; return this; },
    lean: async () => [],
  });
  Product.create = async (data) => {
    observed.creates.push(data);
    return { _id: productId, ...data };
  };
  Product.findByIdAndUpdate = async (id, update) => {
    observed.updates.push({ id, update });
    return { _id: id, ...update.$set };
  };

  t.after(() => {
    Admin.findById = originals.adminFindById;
    Product.countDocuments = originals.productCountDocuments;
    Product.find = originals.productFind;
    Product.create = originals.productCreate;
    Product.findByIdAndUpdate = originals.productFindByIdAndUpdate;
    Vendor.find = originals.vendorFind;
    Vendor.exists = originals.vendorExists;
  });

  const validProduct = {
    name: '  Test item  ',
    price: '12.50',
    vendorId: ' vendor-a ',
    image: ' item.jpg ',
    description: 'Test description',
    isApproved: true,
  };

  await t.test('rejects malformed, zero, negative, and over-limit pagination before database reads', async () => {
    observed.vendorReads = 0;
    for (const query of [{ page: '1abc' }, { page: '0' }, { limit: '-1' }, { limit: '51' }]) {
      const res = await callRoute(productsRouter, '/', makeRequest({ query }));
      assert.equal(res.statusCode, 400, JSON.stringify(query));
    }
    assert.equal(observed.vendorReads, 0);
  });

  await t.test('accepts bounded pagination values and applies the requested offset and limit', async () => {
    observed.pagination = {};
    Product.countDocuments = async () => 100;
    const res = await callRoute(productsRouter, '/', makeRequest({ query: { page: '2', limit: '50' } }));
    assert.equal(res.statusCode, 200);
    assert.deepEqual(observed.pagination, { skip: 50, limit: 50 });
    Product.countDocuments = async () => 1;
  });

  await t.test('both creation routes validate vendor IDs and persist only the same allowed fields', async () => {
    const productRes = await callRoute(
      productsRouter,
      '/',
      makeRequest({ token: tokenFor(), body: validProduct }),
      { method: 'post', skipIndexes: [1] }, // Skip the existing rate limiter; this test covers route validation and writes.
    );
    const adminRes = await callRoute(
      adminRouter,
      '/products',
      makeRequest({ token: tokenFor(), body: validProduct }),
      { method: 'post' },
    );
    assert.equal(productRes.statusCode, 201);
    assert.equal(adminRes.statusCode, 201);
    const expected = {
      name: 'Test item',
      price: 12.5,
      vendorId: 'vendor-a',
      image: 'item.jpg',
      description: 'Test description',
    };
    assert.deepEqual(observed.creates, [expected, expected]);
    assert.deepEqual(Object.keys(observed.creates[0]).sort(), Object.keys(expected).sort());
    assert.deepEqual(Object.keys(observed.creates[1]).sort(), Object.keys(expected).sort());
  });

  await t.test('rejects invalid product fields and unknown vendors without creating products', async () => {
    const createCount = observed.creates.length;
    const invalidFields = await callRoute(
      adminRouter,
      '/products',
      makeRequest({ token: tokenFor(), body: { ...validProduct, price: -1 } }),
      { method: 'post' },
    );
    const invalidProductFields = await callRoute(
      productsRouter,
      '/',
      makeRequest({ token: tokenFor(), body: { ...validProduct, price: -1 } }),
      { method: 'post', skipIndexes: [1] },
    );
    const missingVendor = await callRoute(
      productsRouter,
      '/',
      makeRequest({ token: tokenFor(), body: { ...validProduct, vendorId: 'missing-vendor' } }),
      { method: 'post', skipIndexes: [1] },
    );
    const missingAdminVendor = await callRoute(
      adminRouter,
      '/products',
      makeRequest({ token: tokenFor(), body: { ...validProduct, vendorId: 'missing-vendor' } }),
      { method: 'post' },
    );
    assert.equal(invalidFields.statusCode, 400);
    assert.equal(invalidProductFields.statusCode, 400);
    assert.equal(missingVendor.statusCode, 400);
    assert.equal(missingAdminVendor.statusCode, 400);
    assert.deepEqual(missingVendor.body, { message: 'Vendor not found' });
    assert.equal(observed.creates.length, createCount);
  });

  await t.test('requires the reassigned vendor to exist before updating a product', async () => {
    const missingVendor = await callRoute(
      productsRouter,
      '/:id',
      makeRequest({ token: tokenFor(), params: { id: productId }, body: { vendorId: 'missing-vendor' } }),
      { method: 'put' },
    );
    assert.equal(missingVendor.statusCode, 400);
    assert.equal(observed.updates.length, 0);

    const validVendor = await callRoute(
      productsRouter,
      '/:id',
      makeRequest({ token: tokenFor(), params: { id: productId }, body: { vendorId: 'vendor-a' } }),
      { method: 'put' },
    );
    assert.equal(validVendor.statusCode, 200);
    assert.deepEqual(observed.updates.at(-1), {
      id: productId,
      update: { $set: { vendorId: 'vendor-a' } },
    });
  });

  await t.test('maps vendor lookup and product persistence failures to safe server errors', async () => {
    Vendor.exists = async () => { throw new Error('database details must not reach response'); };
    const lookupFailure = await callRoute(
      adminRouter,
      '/products',
      makeRequest({ token: tokenFor(), body: validProduct }),
      { method: 'post' },
    );
    assert.equal(lookupFailure.statusCode, 500);
    assert.deepEqual(lookupFailure.body, { message: 'Failed to create product' });

    Vendor.exists = async () => ({ _id: 'vendor-document-id' });
    Product.create = async () => { throw new Error('database details must not reach response'); };
    const createFailure = await callRoute(
      productsRouter,
      '/',
      makeRequest({ token: tokenFor(), body: validProduct }),
      { method: 'post', skipIndexes: [1] },
    );
    assert.equal(createFailure.statusCode, 500);
    assert.deepEqual(createFailure.body, { message: 'Failed to create product' });
  });
});
