const REQUIRED_INDEXES = {
  MerchantSubscription: [
    { name: 'uniq_merchant_subscription', key: { merchant: 1 }, unique: true },
    { name: 'subscription_expiry_scan', key: { status: 1, expiresAt: 1 } },
  ],
  SubscriptionPayment: [
    { name: 'merchant_subscription_payments', key: { merchant: 1, createdAt: -1 } },
    { name: 'uniq_subscription_payment_reference', key: { paymentReference: 1 }, unique: true,
      partialFilterExpression: { paymentReference: { $type: 'string' } } },
  ],
};

function equivalent(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
async function verifyModelIndexes(Model, specs) {
  const actual = await Model.collection.listIndexes().toArray();
  for (const spec of specs) {
    const found = actual.find((index) => index.name === spec.name);
    if (!found || !equivalent(found.key, spec.key) || Boolean(found.unique) !== Boolean(spec.unique) ||
      (spec.partialFilterExpression && !equivalent(found.partialFilterExpression, spec.partialFilterExpression))) {
      const error = new Error(`Required index ${spec.name} for ${Model.collection.collectionName} is missing or incompatible`);
      error.code = 'SUBSCRIPTION_INDEX_NOT_READY';
      throw error;
    }
  }
}
async function ensureSubscriptionIndexes(MerchantSubscriptionModel, SubscriptionPaymentModel) {
  await Promise.all([
    verifyModelIndexes(MerchantSubscriptionModel, REQUIRED_INDEXES.MerchantSubscription),
    verifyModelIndexes(SubscriptionPaymentModel, REQUIRED_INDEXES.SubscriptionPayment),
  ]);
}
module.exports = { REQUIRED_INDEXES, ensureSubscriptionIndexes };
