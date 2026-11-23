const mongoose = require('mongoose');

const planSnapshotSchema = new mongoose.Schema({
  id: { type: String, enum: ['free', 'growth', 'premium'], required: true },
  priceKsh: { type: Number, required: true, min: 0 },
  commissionRate: { type: Number, required: true, min: 0, max: 1 },
}, { _id: false, strict: 'throw' });

const merchantSubscriptionSchema = new mongoose.Schema({
  merchant: { type: mongoose.Schema.Types.ObjectId, ref: 'Merchant', required: true, immutable: true },
  plan: { type: planSnapshotSchema, required: true },
  status: { type: String, enum: ['active', 'expired'], required: true, default: 'active' },
  startedAt: { type: Date, required: true },
  expiresAt: { type: Date, default: null },
  pendingDowngrade: { type: planSnapshotSchema, default: null },
  cancelAtExpiry: { type: Boolean, default: false },
  lastPaymentReference: { type: String, default: null },
  history: [{
    event: { type: String, required: true },
    plan: { type: planSnapshotSchema, required: true },
    paymentReference: { type: String, default: null },
    occurredAt: { type: Date, required: true },
  }],
}, { timestamps: true, strict: 'throw', autoIndex: false, autoCreate: false });

merchantSubscriptionSchema.index({ merchant: 1 }, { unique: true, name: 'uniq_merchant_subscription' });
merchantSubscriptionSchema.index({ status: 1, expiresAt: 1 }, { name: 'subscription_expiry_scan' });

module.exports = mongoose.models.MerchantSubscription || mongoose.model('MerchantSubscription', merchantSubscriptionSchema);
