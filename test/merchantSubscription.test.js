const { test } = require('node:test');
const assert = require('node:assert/strict');
const MerchantSubscription = require('../models/MerchantSubscription');
const SubscriptionPayment = require('../models/SubscriptionPayment');
const service = require('../services/merchantSubscriptionService');
const { createMerchantSubscriptionRouter } = require('../routes/merchantSubscription');

const NOW = new Date('2026-05-01T12:00:00.000Z');

function memoryModels() {
  const subscriptions = [];
  const payments = [];
  const doc = (data, list) => ({ ...data, _id: data._id || `id-${list.length + 1}`,
    history: data.history || [], async save() { return this; } });
  const SubscriptionModel = {
    async findOne(filter) { return subscriptions.find((item) => String(item.merchant) === String(filter.merchant)) || null; },
    async create(data) {
      const rows = Array.isArray(data) ? data : [data];
      const created = rows.map((row) => {
        if (subscriptions.some((item) => String(item.merchant) === String(row.merchant))) throw Object.assign(new Error('duplicate'), { code: 11000 });
        const item = doc(row, subscriptions); subscriptions.push(item); return item;
      });
      return Array.isArray(data) ? created : created[0];
    },
    findOne(filter) {
      let found = subscriptions.find((item) => String(item.merchant) === String(filter.merchant)) || null;
      return { session() { return this; }, then(resolve, reject) { return Promise.resolve(found).then(resolve, reject); } };
    },
  };
  const PaymentModel = {
    async create(data) { const item = doc(data, payments); payments.push(item); return item; },
    findOne(filter) {
      const found = payments.find((item) => String(item._id) === String(filter._id)) || null;
      return { session() { return this; }, then(resolve, reject) { return Promise.resolve(found).then(resolve, reject); } };
    },
  };
  return { subscriptions, payments, SubscriptionModel, PaymentModel };
}

test('Merchant has no subscription fields; separate subscription and payment schemas have required indexes', () => {
  assert.equal(MerchantSubscription.schema.path('merchant').options.ref, 'Merchant');
  assert.equal(MerchantSubscription.schema.path('plan.id').enumValues.includes('growth'), true);
  assert.equal(SubscriptionPayment.schema.path('paymentReference').options.default, null);
  const indexes = MerchantSubscription.schema.indexes();
  assert.equal(indexes.some(([key, options]) => key.merchant === 1 && options.unique), true);
  assert.equal(SubscriptionPayment.schema.indexes().some(([, options]) => options.name === 'uniq_subscription_payment_reference'), true);
});

test('server plan configuration carries fixed prices and affiliate rates', () => {
  assert.deepEqual(Object.fromEntries(Object.entries(service.PLANS).map(([id, plan]) => [id, [plan.priceKsh, plan.commissionRate]])), {
    free: [0, 0.3], growth: [300, 0.2], premium: [700, 0.1],
  });
  assert.equal(service.PERIOD_MS, 30 * 24 * 60 * 60 * 1000);
});

test('merchant starts Free and paid upgrade waits for payment; submitted prices are not accepted', async () => {
  const models = memoryModels();
  const current = await service.getEffectiveSubscription('merchant-1', { ...models, now: () => NOW });
  assert.equal(current.plan.id, 'free');
  const request = await service.requestUpgrade('merchant-1', 'growth', { ...models, now: () => NOW });
  assert.equal(request.payment.status, 'pending');
  assert.equal(request.payment.amountKsh, 300);
  assert.equal(current.plan.id, 'free');
  await assert.rejects(service.requestUpgrade('merchant-1', 'free', models), /paid plan/);
});

test('verified activation starts a 30-day period, locks snapshots, and blocks duplicate application', async () => {
  const models = memoryModels();
  const payment = await models.PaymentModel.create({ merchant: 'merchant-1', plan: 'premium', amountKsh: 700,
    status: 'verified', paymentReference: 'provider-ref-1', requestedAt: NOW, verifiedAt: NOW });
  const fakeSession = { async withTransaction(fn) { await fn(); }, async endSession() {} };
  const activated = await service.activatePaidPlanAfterVerifiedPayment(payment._id, {
    ...models, now: NOW, session: fakeSession,
  });
  assert.equal(activated.plan.id, 'premium');
  assert.equal(activated.plan.priceKsh, 700);
  assert.equal(activated.plan.commissionRate, 0.1);
  assert.equal(activated.expiresAt.getTime() - NOW.getTime(), service.PERIOD_MS);
  assert.equal(payment.status, 'applied');
  const again = await service.activatePaidPlanAfterVerifiedPayment(payment._id, { ...models, now: NOW, session: fakeSession });
  assert.equal(again._id, activated._id);
});

test('downgrade schedules at expiry, cancellation retains access, and expired paid plan resolves to Free', async () => {
  const models = memoryModels();
  const sub = await models.SubscriptionModel.create({ merchant: 'merchant-2', plan: service.snapshot('premium'), status: 'active',
    startedAt: NOW, expiresAt: new Date(NOW.getTime() + service.PERIOD_MS), history: [] });
  const scheduled = await service.scheduleDowngrade('merchant-2', 'growth', { ...models, now: () => NOW });
  assert.equal(scheduled.pendingDowngrade.id, 'growth');
  await service.cancelDowngrade('merchant-2', { ...models, now: () => NOW });
  assert.equal(sub.pendingDowngrade, null);
  await service.cancelRenewal('merchant-2', { ...models, now: () => NOW });
  assert.equal(sub.plan.id, 'premium');
  assert.equal(sub.cancelAtExpiry, true);
  const expired = await service.getEffectiveSubscription('merchant-2', { ...models, now: () => new Date(NOW.getTime() + service.PERIOD_MS + 1) });
  assert.equal(expired.plan.id, 'free');
  assert.equal(expired.expiresAt, null);
});

test('late renewal activation begins a fresh period from confirmation time', async () => {
  const models = memoryModels();
  const late = new Date(NOW.getTime() + service.PERIOD_MS * 2);
  const payment = await models.PaymentModel.create({ merchant: 'merchant-3', plan: 'growth', amountKsh: 300,
    status: 'verified', paymentReference: 'provider-ref-2', requestedAt: NOW, verifiedAt: late });
  const fakeSession = { async withTransaction(fn) { await fn(); }, async endSession() {} };
  const sub = await service.activatePaidPlanAfterVerifiedPayment(payment._id, { ...models, now: late, session: fakeSession });
  assert.equal(sub.startedAt.getTime(), late.getTime());
  assert.equal(sub.expiresAt.getTime(), late.getTime() + service.PERIOD_MS);
});

test('renewal uses the pending downgrade plan and amount', async () => {
  const models = memoryModels();
  await models.SubscriptionModel.create({ merchant: 'merchant-renewal', plan: service.snapshot('premium'), status: 'active',
    startedAt: NOW, expiresAt: new Date(NOW.getTime() + service.PERIOD_MS), pendingDowngrade: service.snapshot('growth'), history: [] });

  const result = await service.requestRenewal('merchant-renewal', { ...models, now: () => NOW });

  assert.equal(result.plan.id, 'growth');
  assert.equal(result.payment.plan, 'growth');
  assert.equal(result.payment.amountKsh, 300);
  assert.equal(result.payment.status, 'pending');
});

test('subscription API protects every endpoint and rejects client-supplied price or rate', async () => {
  const protect = (_req, _res, next) => next();
  const router = createMerchantSubscriptionRouter({ protect });
  for (const layer of router.stack.filter((item) => item.route)) {
    assert.equal(layer.route.stack[0].handle, protect);
  }
  const upgrade = router.stack.find((item) => item.route?.path === '/upgrade').route.stack[1].handle;
  let status;
  let body;
  await upgrade({ body: { planId: 'growth', priceKsh: 1, commissionRate: 0.99 } }, {
    status(value) { status = value; return this; },
    json(value) { body = value; return this; },
  }, (error) => { throw error; });
  assert.equal(status, 400);
  assert.match(body.message, /only a valid planId/i);
});
