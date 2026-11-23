const mongoose = require('mongoose');
const MerchantSubscription = require('../models/MerchantSubscription');
const SubscriptionPayment = require('../models/SubscriptionPayment');

const PERIOD_MS = 30 * 24 * 60 * 60 * 1000;
const PLANS = Object.freeze({
  free: Object.freeze({ id: 'free', name: 'Free', priceKsh: 0, commissionRate: 0.30 }),
  growth: Object.freeze({ id: 'growth', name: 'Growth', priceKsh: 300, commissionRate: 0.20 }),
  premium: Object.freeze({ id: 'premium', name: 'Premium', priceKsh: 700, commissionRate: 0.10 }),
});
const snapshot = (planId) => {
  const plan = PLANS[planId];
  if (!plan) throw Object.assign(new Error('Invalid subscription plan'), { status: 400 });
  return { id: plan.id, priceKsh: plan.priceKsh, commissionRate: plan.commissionRate };
};
const makeError = (message, status = 409) => Object.assign(new Error(message), { status });

async function ensureRecord(merchantId, { SubscriptionModel = MerchantSubscription, now = new Date() } = {}) {
  let record = await SubscriptionModel.findOne({ merchant: merchantId });
  if (!record) {
    try {
      record = await SubscriptionModel.create({ merchant: merchantId, plan: snapshot('free'), status: 'active', startedAt: now, expiresAt: null,
        history: [{ event: 'free_initialized', plan: snapshot('free'), occurredAt: now }] });
    } catch (error) {
      if (error.code !== 11000) throw error;
      record = await SubscriptionModel.findOne({ merchant: merchantId });
    }
  }
  return record;
}

async function applyEffectiveState(record, { now = new Date() } = {}) {
  if (record.plan.id === 'free' || !record.expiresAt || new Date(record.expiresAt) > now) return record;
  const nextPlan = snapshot('free');
  const event = record.cancelAtExpiry ? 'cancelled_to_free' : 'expired_to_free';
  record.plan = nextPlan;
  record.status = 'active';
  record.startedAt = now;
  record.expiresAt = null;
  record.cancelAtExpiry = false;
  record.history.push({ event, plan: nextPlan, occurredAt: now });
  await record.save();
  return record;
}

async function getEffectiveSubscription(merchantId, deps = {}) {
  const now = deps.now ? deps.now() : new Date();
  const record = await ensureRecord(merchantId, { ...deps, now });
  return applyEffectiveState(record, { now });
}

async function requestUpgrade(merchantId, planId, deps = {}) {
  if (!['growth', 'premium'].includes(planId)) throw makeError('Choose a paid plan to upgrade to', 400);
  const plan = snapshot(planId);
  const current = await getEffectiveSubscription(merchantId, deps);
  if (current.plan.id === planId) throw makeError('Merchant is already on this plan');
  if (PLANS[planId].priceKsh <= PLANS[current.plan.id].priceKsh) throw makeError('This request is not an upgrade');
  const PaymentModel = deps.PaymentModel || SubscriptionPayment;
  const payment = await PaymentModel.create({ merchant: merchantId, plan: planId, amountKsh: plan.priceKsh,
    status: 'pending', requestedAt: deps.now ? deps.now() : new Date() });
  return { payment, plan, message: 'Payment is pending. The plan activates only after verified payment confirmation.' };
}

async function requestRenewal(merchantId, deps = {}) {
  const current = await getEffectiveSubscription(merchantId, deps);
  const targetPlanId = current.pendingDowngrade?.id || current.plan.id;
  if (targetPlanId === 'free') throw makeError('Choose a paid plan to renew', 400);
  const plan = snapshot(targetPlanId);
  const PaymentModel = deps.PaymentModel || SubscriptionPayment;
  const payment = await PaymentModel.create({ merchant: merchantId, plan: targetPlanId, amountKsh: plan.priceKsh,
    status: 'pending', requestedAt: deps.now ? deps.now() : new Date() });
  return { payment, plan, message: 'Renewal payment is pending. The new period begins after verified payment confirmation.' };
}

async function scheduleDowngrade(merchantId, planId, deps = {}) {
  const plan = snapshot(planId);
  const current = await getEffectiveSubscription(merchantId, deps);
  if (!current.expiresAt || planId === current.plan.id || PLANS[planId].priceKsh >= PLANS[current.plan.id].priceKsh) {
    throw makeError('Choose a lower plan for the next renewal');
  }
  current.pendingDowngrade = plan;
  current.cancelAtExpiry = false;
  current.history.push({ event: 'downgrade_scheduled', plan, occurredAt: deps.now ? deps.now() : new Date() });
  await current.save();
  return current;
}

async function cancelDowngrade(merchantId, deps = {}) {
  const current = await getEffectiveSubscription(merchantId, deps);
  if (!current.pendingDowngrade) throw makeError('There is no scheduled downgrade');
  current.pendingDowngrade = null;
  current.history.push({ event: 'downgrade_cancelled', plan: current.plan, occurredAt: deps.now ? deps.now() : new Date() });
  await current.save();
  return current;
}

async function cancelRenewal(merchantId, deps = {}) {
  const current = await getEffectiveSubscription(merchantId, deps);
  if (current.plan.id === 'free' || !current.expiresAt) throw makeError('Free subscriptions do not renew');
  current.cancelAtExpiry = true;
  current.pendingDowngrade = null;
  current.history.push({ event: 'renewal_cancelled', plan: current.plan, occurredAt: deps.now ? deps.now() : new Date() });
  await current.save();
  return current;
}

// Stage 2 must mark a payment verified only after provider verification. This function
// is intentionally a service boundary and is not exposed as an HTTP endpoint in Stage 1.
async function activatePaidPlanAfterVerifiedPayment(paymentId, { SubscriptionModel = MerchantSubscription,
  PaymentModel = SubscriptionPayment, session: providedSession, now = new Date() } = {}) {
  const session = providedSession || await mongoose.startSession();
  let result;
  try {
    const work = async () => {
      const payment = await PaymentModel.findOne({ _id: paymentId }).session(session);
      if (!payment) throw makeError('Verified subscription payment not found');
      if (payment.status === 'applied' && payment.appliedAt) {
        result = await SubscriptionModel.findOne({ merchant: payment.merchant }).session(session);
        return;
      }
      if (payment.status !== 'verified') throw makeError('Verified subscription payment not found');
      const plan = snapshot(payment.plan);
      if (payment.amountKsh !== plan.priceKsh || !payment.paymentReference) throw makeError('Verified payment details do not match the configured plan');
      let sub = await SubscriptionModel.findOne({ merchant: payment.merchant }).session(session);
      if (!sub) [sub] = await SubscriptionModel.create([{ merchant: payment.merchant, plan: snapshot('free'), status: 'active', startedAt: now, history: [] }], { session });
      sub.plan = plan;
      sub.status = 'active';
      sub.startedAt = now;
      sub.expiresAt = new Date(now.getTime() + PERIOD_MS);
      sub.pendingDowngrade = null;
      sub.cancelAtExpiry = false;
      sub.lastPaymentReference = payment.paymentReference;
      sub.history.push({ event: 'paid_plan_activated', plan, paymentReference: payment.paymentReference, occurredAt: now });
      await sub.save({ session });
      payment.status = 'applied';
      payment.appliedAt = now;
      await payment.save({ session });
      result = sub;
    };
    if (providedSession) await work(); else await session.withTransaction(work);
    return result;
  } finally { if (!providedSession) await session.endSession(); }
}

module.exports = { PERIOD_MS, PLANS, snapshot, getEffectiveSubscription, requestUpgrade, scheduleDowngrade,
  requestRenewal, cancelDowngrade, cancelRenewal, activatePaidPlanAfterVerifiedPayment, applyEffectiveState };
