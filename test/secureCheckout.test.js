const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = 'unit-test-secret-that-is-at-least-thirty-two-characters';
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Product = require('../models/Product');
const Vendor = require('../models/Vendor');
const Order = require('../models/Order');
const Cart = require('../models/Cart');
const orderRouter = require('../routes/order');

const visibleProductId = '507f1f77bcf86cd799439021';
const hiddenProductId = '507f1f77bcf86cd799439022';
const customerA = '507f1f77bcf86cd799439031';
const customerB = '507f1f77bcf86cd799439032';
const key = 'checkout-retry-key-0001';

function makeResponse() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

async function postOrder(userId, products, idempotencyKey = key) {
  const layer = orderRouter.stack.find((entry) => entry.route?.path === '/' && entry.route.methods.post);
  assert.ok(layer, 'Expected POST / order route');
  const handlers = layer.route.stack.map((entry) => entry.handle);
  const req = {
    cookies: { token: jwt.sign({ id: userId }, process.env.JWT_SECRET, { algorithm: 'HS256' }) },
    get(name) { return name.toLowerCase() === 'idempotency-key' ? idempotencyKey : undefined; },
    body: { products },
  };
  const res = makeResponse();
  const dispatch = async (index, error) => {
    if (error) throw error;
    if (index >= handlers.length) return;
    return handlers[index](req, res, (nextError) => dispatch(index + 1, nextError));
  };
  await dispatch(0);
  return res;
}

test('checkout enforces marketplace visibility and safely recovers keyed retries', async (t) => {
  const originals = {
    userFindById: User.findById,
    productFind: Product.find,
    vendorFind: Vendor.find,
    vendorFindOne: Vendor.findOne,
    orderCreate: Order.create,
    orderFindOne: Order.findOne,
    cartUpdateOne: Cart.updateOne,
  };
  const state = {
    products: [
      { _id: visibleProductId, vendorId: 'visible-vendor', name: 'Visible item', price: 25 },
      { _id: hiddenProductId, vendorId: 'hidden-vendor', name: 'Hidden item', price: 40 },
    ],
    orders: new Map(),
    creates: 0,
    cartCalls: [],
    failCreate: false,
    failCartCalls: 0,
    lastProductFilter: null,
    lastLookup: null,
  };

  User.findById = (id) => ({
    select() { return this; },
    lean: async () => ({ _id: id, fullName: 'Test Customer', email: 'customer@example.test' }),
  });
  Vendor.find = (filter) => {
    assert.deepEqual(filter, Vendor.publicMarketplaceFilter());
    return { distinct: async () => ['visible-vendor'] };
  };
  Vendor.findOne = () => ({ select() { return this; }, lean: async () => null });
  Product.find = (filter) => {
    state.lastProductFilter = filter;
    return {
      select() { return this; },
      lean: async () => state.products.filter((product) =>
        filter._id.$in.includes(product._id) && filter.vendorId.$in.includes(product.vendorId)),
    };
  };
  Order.findOne = (filter) => {
    state.lastLookup = filter;
    return { select: async () => state.orders.get(`${filter.user}:${filter.idempotencyKey}`) || null };
  };
  Order.create = async (data) => {
    state.creates += 1;
    if (state.failCreate) throw new Error('simulated order persistence failure');
    const order = { _id: `507f1f77bcf86cd7994390${String(state.creates).padStart(2, '0')}`, ...data };
    if (data.idempotencyKey) state.orders.set(`${data.user}:${data.idempotencyKey}`, order);
    return order;
  };
  Cart.updateOne = async (filter, update) => {
    state.cartCalls.push({ filter, update });
    if (state.failCartCalls > 0) {
      state.failCartCalls -= 1;
      throw new Error('simulated cart cleanup failure');
    }
    return { acknowledged: true };
  };

  t.after(() => {
    User.findById = originals.userFindById;
    Product.find = originals.productFind;
    Vendor.find = originals.vendorFind;
    Vendor.findOne = originals.vendorFindOne;
    Order.create = originals.orderCreate;
    Order.findOne = originals.orderFindOne;
    Cart.updateOne = originals.cartUpdateOne;
  });

  await t.test('hidden and mixed product IDs are rejected before order or cart writes', async () => {
    const hidden = await postOrder(customerA, [{ productId: hiddenProductId, quantity: 1 }]);
    assert.equal(hidden.statusCode, 400);
    const mixed = await postOrder(customerA, [
      { productId: visibleProductId, quantity: 1 },
      { productId: hiddenProductId, quantity: 1 },
    ]);
    assert.equal(mixed.statusCode, 400);
    assert.equal(state.creates, 0);
    assert.equal(state.cartCalls.length, 0);
    assert.deepEqual(state.lastProductFilter.vendorId, { $in: ['visible-vendor'] });
  });

  await t.test('visible products use server prices and clear only the authenticated customer’s purchased lines', async () => {
    const res = await postOrder(customerA, [{ productId: visibleProductId, quantity: 2, price: 0.01 }]);
    assert.equal(res.statusCode, 201);
    assert.equal(res.body.totalPrice, 50);
    assert.equal(res.body.products[0].price, 25);
    assert.equal(res.body.idempotencyKey, undefined);
    assert.equal(state.cartCalls.length, 1);
    assert.equal(state.cartCalls[0].filter.user, customerA);
    const cartPredicate = state.cartCalls[0].update[0].$set.items.$filter.cond.$not[0].$or;
    assert.deepEqual(cartPredicate[0].$and[1].$in[1].map(String), [visibleProductId]);
    assert.deepEqual(cartPredicate[1].$and[1].$in[1], []);
    assert.deepEqual(state.cartCalls[0].update[0].$set.processedOrderIds.$concatArrays[1].map(String), [res.body._id]);
  });

  await t.test('order persistence failure leaves the cart untouched', async () => {
    state.failCreate = true;
    const before = state.cartCalls.length;
    const res = await postOrder(customerA, [{ productId: visibleProductId, quantity: 1 }], 'failure-key-00000001');
    state.failCreate = false;
    assert.equal(res.statusCode, 500);
    assert.equal(state.cartCalls.length, before);
  });

  await t.test('same customer and key replay the saved order without creating a duplicate', async () => {
    const first = await postOrder(customerA, [{ productId: visibleProductId, quantity: 1 }], 'repeat-key-000000001');
    const before = state.creates;
    const replay = await postOrder(customerA, [{ productId: visibleProductId, quantity: 1 }], 'repeat-key-000000001');
    assert.equal(first.statusCode, 201);
    assert.equal(replay.statusCode, 200);
    assert.equal(replay.body._id, first.body._id);
    assert.equal(state.creates, before);
    assert.deepEqual(state.lastLookup, { user: customerA, idempotencyKey: 'repeat-key-000000001' });
  });

  await t.test('different customers have separate records for the same key', async () => {
    const before = state.creates;
    const res = await postOrder(customerB, [{ productId: visibleProductId, quantity: 1 }], 'shared-key-0000000001');
    assert.equal(res.statusCode, 201);
    assert.equal(state.creates, before + 1);
    assert.deepEqual(state.lastLookup, { user: customerB, idempotencyKey: 'shared-key-0000000001' });
  });

  await t.test('a cart cleanup failure is visible and the same key safely completes cleanup on retry', async () => {
    const retryKey = 'cleanup-retry-key-000001';
    state.failCartCalls = 1;
    const beforeCreates = state.creates;
    const failedResponse = await postOrder(customerA, [{ productId: visibleProductId, quantity: 3 }], retryKey);
    assert.equal(failedResponse.statusCode, 500);
    assert.equal(failedResponse.body.orderCreated, true);
    assert.equal(failedResponse.body.retryWithSameIdempotencyKey, true);
    const recoveredResponse = await postOrder(customerA, [{ productId: visibleProductId, quantity: 3 }], retryKey);
    assert.equal(recoveredResponse.statusCode, 200);
    assert.equal(recoveredResponse.body._id, failedResponse.body.orderId);
    assert.equal(state.creates, beforeCreates + 1);
    assert.equal(state.cartCalls.at(-1).filter.user, customerA);
    assert.equal(String(state.cartCalls.at(-1).filter.processedOrderIds.$ne), failedResponse.body.orderId);
  });

  await t.test('reusing a key for a different checkout payload conflicts', async () => {
    await postOrder(customerA, [{ productId: visibleProductId, quantity: 1 }], 'payload-key-00000001');
    const res = await postOrder(customerA, [{ productId: visibleProductId, quantity: 2 }], 'payload-key-00000001');
    assert.equal(res.statusCode, 409);
  });
});

test('Order schema declares customer-scoped uniqueness for keyed checkout records', () => {
  const indexes = Order.schema.indexes();
  assert.ok(indexes.some(([keys, options]) =>
    keys.user === 1 && keys.idempotencyKey === 1 && options.unique === true &&
    options.partialFilterExpression?.idempotencyKey?.$type === 'string'));
});
