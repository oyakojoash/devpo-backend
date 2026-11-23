const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = 'unit-test-secret-that-is-at-least-thirty-two-characters';
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Product = require('../models/Product');
const Order = require('../models/Order');
const Cart = require('../models/Cart');
const Vendor = require('../models/Vendor');
const orderRouter = require('../routes/order');

const productId = '507f1f77bcf86cd799439012';
const orderId = '507f1f77bcf86cd799439013';
const customerA = '507f1f77bcf86cd799439014';
const customerB = '507f1f77bcf86cd799439015';

function makeResponse() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

async function postOrder(userId, products = [{ productId, quantity: 2 }]) {
  const layer = orderRouter.stack.find((entry) => entry.route?.path === '/' && entry.route.methods.post);
  assert.ok(layer, 'Expected POST / order route');
  const handlers = layer.route.stack.map((entry) => entry.handle);
  const req = {
    cookies: { token: jwt.sign({ id: userId }, process.env.JWT_SECRET, { algorithm: 'HS256' }) },
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

test('customer checkout persists order before clearing only that customer?s purchased cart items', async (t) => {
  const originals = {
    userFindById: User.findById,
    productFind: Product.find,
    orderCreate: Order.create,
    cartUpdateOne: Cart.updateOne,
    vendorFind: Vendor.find,
    vendorFindOne: Vendor.findOne,
  };
  const events = [];
  let failingOrder = false;
  let authenticatedUserId = null;

  User.findById = (id) => ({
    select() { return this; },
    lean: async () => ({ _id: id, fullName: 'Test Customer', email: 'customer@example.test' }),
  });
  Product.find = () => ({
    select() { return this; },
    lean: async () => [{ _id: productId, name: 'Test product', price: 25 }],
  });
  Vendor.find = () => ({ distinct: async () => ['visible-vendor'] });
  Vendor.findOne = () => ({ select() { return this; }, lean: async () => null });
  Order.create = async (data) => {
    events.push('order');
    if (failingOrder) throw new Error('simulated order persistence failure');
    return { _id: orderId, ...data };
  };
  Cart.updateOne = async (filter, update) => {
    events.push('cart');
    assert.deepEqual(filter.user, authenticatedUserId);
    assert.equal(String(filter.processedOrderIds.$ne), orderId);
    const predicates = update[0].$set.items.$filter.cond.$not[0].$or;
    assert.equal(predicates[0].$and[0].$eq[0].$ifNull[0], '$$item.sourceType');
    assert.deepEqual(predicates[0].$and[1].$in[1].map(String), [productId]);
    assert.deepEqual(predicates[1].$and[1].$in[1], []);
    assert.deepEqual(update[0].$set.processedOrderIds.$concatArrays[1].map(String), [orderId]);
    return { acknowledged: true, modifiedCount: 1 };
  };

  try {
    await t.test('successful checkout clears the purchased item after order creation', async () => {
      events.length = 0;
      authenticatedUserId = customerA;
      const res = await postOrder(customerA);
      assert.equal(res.statusCode, 201);
      assert.equal(res.body.totalPrice, 50);
      assert.deepEqual(events, ['order', 'cart']);
    });

    await t.test('failed order persistence leaves the cart untouched', async () => {
      events.length = 0;
      authenticatedUserId = customerA;
      failingOrder = true;
      const res = await postOrder(customerA);
      failingOrder = false;
      assert.equal(res.statusCode, 500);
      assert.deepEqual(events, ['order']);
    });

    await t.test('cart clearing is scoped to the authenticated customer', async () => {
      events.length = 0;
      authenticatedUserId = customerB;
      const res = await postOrder(customerB);
      assert.equal(res.statusCode, 201);
      assert.deepEqual(events, ['order', 'cart']);
    });
  } finally {
    User.findById = originals.userFindById;
    Product.find = originals.productFind;
    Order.create = originals.orderCreate;
    Cart.updateOne = originals.cartUpdateOne;
    Vendor.find = originals.vendorFind;
    Vendor.findOne = originals.vendorFindOne;
  }
});
