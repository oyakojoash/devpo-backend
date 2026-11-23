const mongoose = require('mongoose');

const conversationSchema = new mongoose.Schema({
  customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  merchantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Merchant' },
  affiliateId: { type: mongoose.Schema.Types.ObjectId, ref: 'Affiliate' },
  lastMessage: { type: String, default: '' },
  lastMessageAt: { type: Date, default: null },
  customerUnreadCount: { type: Number, default: 0, min: 0 },
  merchantUnreadCount: { type: Number, default: 0, min: 0 },
  affiliateUnreadCount: { type: Number, default: 0, min: 0 },
}, { timestamps: true, autoIndex: false, autoCreate: false });

conversationSchema.pre('validate', function validateRecipient() {
  if (Boolean(this.merchantId) === Boolean(this.affiliateId)) {
    this.invalidate('merchantId', 'A conversation must have exactly one Merchant or Affiliate recipient');
  }
});

conversationSchema.index(
  { customerId: 1, merchantId: 1 },
  { unique: true, name: 'uniq_customer_merchant_conversation_v2', partialFilterExpression: { merchantId: { $type: 'objectId' } } },
);
conversationSchema.index(
  { customerId: 1, affiliateId: 1 },
  { unique: true, name: 'uniq_customer_affiliate_conversation', partialFilterExpression: { affiliateId: { $type: 'objectId' } } },
);
conversationSchema.index({ customerId: 1, updatedAt: -1, _id: -1 }, { name: 'customer_conversation_list' });
conversationSchema.index({ merchantId: 1, updatedAt: -1, _id: -1 }, { name: 'merchant_conversation_list' });
conversationSchema.index({ affiliateId: 1, updatedAt: -1, _id: -1 }, { name: 'affiliate_conversation_list' });

module.exports = mongoose.models.Conversation || mongoose.model('Conversation', conversationSchema);
