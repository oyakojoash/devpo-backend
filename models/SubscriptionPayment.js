const mongoose = require('mongoose');

const subscriptionPaymentSchema = new mongoose.Schema({
  merchant: { type: mongoose.Schema.Types.ObjectId, ref: 'Merchant', required: true, immutable: true },
  plan: { type: String, enum: ['growth', 'premium'], required: true, immutable: true },
  amountKsh: { type: Number, required: true, min: 1, immutable: true },
  status: { type: String, enum: ['pending', 'verified', 'applied', 'failed'], default: 'pending', required: true },
  paymentReference: { type: String, default: null },
  requestedAt: { type: Date, required: true },
  verifiedAt: { type: Date, default: null },
  appliedAt: { type: Date, default: null },
}, { timestamps: true, strict: 'throw', autoIndex: false, autoCreate: false });

subscriptionPaymentSchema.index({ merchant: 1, createdAt: -1 }, { name: 'merchant_subscription_payments' });
subscriptionPaymentSchema.index({ paymentReference: 1 }, {
  unique: true,
  name: 'uniq_subscription_payment_reference',
  partialFilterExpression: { paymentReference: { $type: 'string' } },
});

module.exports = mongoose.models.SubscriptionPayment || mongoose.model('SubscriptionPayment', subscriptionPaymentSchema);
