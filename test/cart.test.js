const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const Cart = require('../models/Cart');
const Product = require('../models/Product');
const MerchantProduct = require('../models/MerchantProduct');
const Vendor = require('../models/Vendor');
const router = require('../routes/cart');

const SAME_ID = '507f1f77bcf86cd799439001';
const OWNER = '507f1f77bcf86cd799439010';
const OTHER = '507f1f77bcf86cd799439011';
const MERCHANT = '507f1f77bcf86cd799439012';

function query(value) {
  return { select() { return this; }, lean: async () => value };
}

function response() {
  return { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}

async function call(method, path, req) {
  const route = router.stack.find((layer) => layer.route?.path === path && layer.route.methods[method]);
  assert.ok(route, `${method} ${path} exists`);
  const res = response();
  await route.route.stack.at(-1).handle(req, res);
  return res;
}

test('cart keeps typed identities, legacy compatibility, CRUD, availability, and customer scoping', async (t) => {
  const originals = {
    cartFindOne: Cart.findOne,
    productFindById: Product.findById,
    merchantFindOne: MerchantProduct.findOne,
    vendorFindOne: Vendor.findOne,
    vendorFind: Vendor.find,
    vendorExists: Vendor.exists,
  };
  const cart = {
    user: new mongoose.Types.ObjectId(OWNER),
    items: [{ productId: new mongoose.Types.ObjectId(SAME_ID), quantity: 1 }], // pre-sourceType legacy row
    async save() { return this; },
  };
  let merchantStock = 4;
  const legacy = { _id: new mongoose.Types.ObjectId(SAME_ID), name: 'Legacy', price: 10, image: 'legacy.jpg', vendorId: 'old-public-store' };
  const merchant = {
    _id: new mongoose.Types.ObjectId(SAME_ID), name: 'Merchant', description: 'New item', model: 'retail',
    status: 'active', archivedAt: null, retail: { price: 20, get stock() { return merchantStock; } },
    images: ['/merchant.png'], merchant: new mongoose.Types.ObjectId(MERCHANT),
  };
  Product.findById = (id) => query(String(id) === SAME_ID ? legacy : null);
  MerchantProduct.findOne = (filter) => query(filter._id.toString() === SAME_ID && merchantStock >= 0 ? merchant : null);
  Vendor.findOne = (filter) => filter.id === 'old-public-store'
    ? query({ id: 'old-public-store', name: 'Legacy store', logo: 'legacy-logo.png' })
    : query(null);
  Vendor.find = () => query([{ _id: 'vendor-row', id: 'merchant-store', name: 'Merchant store', logo: 'merchant-logo.png' }]);
  Vendor.exists = async () => ({ _id: 'vendor-row' });
  Cart.findOne = async ({ user }) => String(user) === OWNER ? cart : null;
  t.after(() => {
    Cart.findOne = originals.cartFindOne;
    Product.findById = originals.productFindById;
    MerchantProduct.findOne = originals.merchantFindOne;
    Vendor.findOne = originals.vendorFindOne;
    Vendor.find = originals.vendorFind;
    Vendor.exists = originals.vendorExists;
  });

  const hydrated = await call('get', '/', { user: { _id: OWNER } });
  assert.equal(hydrated.body.items[0].sourceType, 'product');
  assert.equal(hydrated.body.items[0].productId.name, 'Legacy');

  let added = await call('post', '/', { user: { _id: OWNER }, body: { productId: SAME_ID, sourceType: 'merchantProduct', quantity: 2 } });
  assert.equal(added.statusCode, 200);
  assert.equal(cart.items.length, 2);
  assert.deepEqual(cart.items.map((item) => item.sourceType || 'product').sort(), ['merchantProduct', 'product']);
  assert.equal(added.body.items.find((item) => item.sourceType === 'merchantProduct').productId.name, 'Merchant');
  assert.equal(added.body.items.find((item) => item.sourceType === 'merchantProduct').availableQuantity, 4);

  await call('post', '/', { user: { _id: OWNER }, body: { productId: SAME_ID, quantity: 3 } });
  assert.equal(cart.items.find((item) => !item.sourceType).quantity, 3); // old API still means Product
  await call('post', '/', { user: { _id: OWNER }, body: { productId: SAME_ID, sourceType: 'merchantProduct', quantity: 4 } });
  assert.equal(cart.items.find((item) => item.sourceType === 'merchantProduct').quantity, 4);
  const excessive = await call('post', '/', { user: { _id: OWNER }, body: { productId: SAME_ID, sourceType: 'merchantProduct', quantity: 5 } });
  assert.equal(excessive.statusCode, 409);
  assert.equal(excessive.body.availableQuantity, 4);
  assert.equal(excessive.body.requestedQuantity, 5);
  assert.match(excessive.body.message, /Only 4 units are currently available/);
  assert.equal(cart.items.find((item) => item.sourceType === 'merchantProduct').quantity, 4);

  const removed = await call('delete', '/:productId', {
    user: { _id: OWNER }, params: { productId: SAME_ID }, query: { sourceType: 'merchantProduct' },
  });
  assert.equal(removed.statusCode, 200);
  assert.equal(cart.items.length, 1);
  assert.equal(cart.items[0].productId.toString(), SAME_ID);

  merchantStock = 0;
  cart.items.push({ productId: new mongoose.Types.ObjectId(SAME_ID), sourceType: 'merchantProduct', quantity: 1 });
  const staleCart = await call('get', '/', { user: { _id: OWNER } });
  const staleItem = staleCart.body.items.find((item) => item.sourceType === 'merchantProduct');
  assert.equal(staleItem.available, false);
  assert.equal(staleItem.availableQuantity, 0);
  const unavailable = await call('post', '/', { user: { _id: OWNER }, body: { productId: SAME_ID, sourceType: 'merchantProduct', quantity: 1 } });
  assert.equal(unavailable.statusCode, 409);
  assert.equal(unavailable.body.availableQuantity, 0);
  assert.match(unavailable.body.message, /out of stock/i);

  const otherCustomer = await call('get', '/', { user: { _id: OTHER } });
  assert.deepEqual(otherCustomer.body.items, []);
});
