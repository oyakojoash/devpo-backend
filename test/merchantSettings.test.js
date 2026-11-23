const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createMerchantSettingsRouter, normalizeSection, vendorSettings } = require('../routes/merchantSettings');

async function callRoute(router, path, method, req) {
  const layer = router.stack.find((entry) => entry.route?.path === path && entry.route.methods[method]);
  assert.ok(layer);
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  for (const { handle } of layer.route.stack) {
    let continued = false;
    await handle(req, res, () => { continued = true; });
    if (!continued || res.body !== undefined) break;
  }
  return res;
}

test('merchant settings accept allowed values and reject ownership or privileged fields', () => {
  assert.deepEqual(normalizeSection('store', { visible: false, name: 'My shop' }).value, { visible: false, name: 'My shop' });
  assert.equal(normalizeSection('store', { merchantId: 'another-merchant' }).error, 'Invalid settings or unsupported fields');
  assert.equal(normalizeSection('store', { status: 'active' }).error, 'Invalid settings or unsupported fields');
  assert.equal(normalizeSection('notifications', { orders: 'yes' }).error, 'Invalid orders');
});

test('merchant settings validate delivery, image references, and support contact input', () => {
  assert.deepEqual(normalizeSection('delivery', { areas: 'Nairobi, Kiambu, Nairobi', charge: '50' }).value, { areas: ['Nairobi', 'Kiambu'], charge: 50 });
  assert.equal(normalizeSection('delivery', { charge: -1 }).error, 'Enter a valid delivery charge');
  assert.equal(normalizeSection('store', { logo: 'javascript:alert(1)' }).error, 'Use an HTTPS image URL or an uploaded image reference');
  assert.equal(normalizeSection('policies', { supportEmail: 'invalid' }).error, 'Enter a valid support email address');
});

test('vendor settings serializer does not include merchant ownership or approval fields', () => {
  const result = vendorSettings({ _id: 'private-id', merchantId: 'owner', name: 'Shop', settings: { payments: { receivingDetails: 'private' } } });
  assert.equal(result.store.name, 'Shop');
  assert.equal(result.payments.receivingDetails, 'private');
  assert.equal(Object.hasOwn(result, 'merchantId'), false);
  assert.equal(Object.hasOwn(result, 'approvalStatus'), false);
});

test('authenticated settings updates use the merchant from middleware and reject forged fields', async () => {
  const updates = [];
  const router = createMerchantSettingsRouter({
    protect(req, _res, next) { req.merchant = { _id: 'authenticated-owner' }; next(); },
    MerchantModel: {
      findByIdAndUpdate(id, update) {
        updates.push({ id, update });
        return { select() { return this; }, lean: async () => ({ settings: { notifications: update.$set['settings.notifications'] } }) };
      },
    },
  });
  const saved = await callRoute(router, '/', 'put', { body: { section: 'notifications', settings: { orders: false } } });
  assert.equal(saved.statusCode, 200);
  assert.equal(updates[0].id, 'authenticated-owner');
  assert.deepEqual(updates[0].update.$set['settings.notifications'], { orders: false });

  const rejected = await callRoute(router, '/', 'put', { body: { section: 'notifications', settings: { isAdmin: true } } });
  assert.equal(rejected.statusCode, 400);
  assert.equal(updates.length, 1);
});
