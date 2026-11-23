const crypto = require('node:crypto');
const mongoose = require('mongoose');

const CODE_BYTES = 12;
const affiliateReferralSchema = new mongoose.Schema({
  affiliate: { type: mongoose.Schema.Types.ObjectId, ref: 'Affiliate', required: true, immutable: true },
  affiliatePromotion: { type: mongoose.Schema.Types.ObjectId, ref: 'AffiliatePromotion', required: true, immutable: true },
  product: { type: mongoose.Schema.Types.ObjectId, ref: 'MerchantProduct', required: true, immutable: true },
  referralCode: { type: String, required: true, immutable: true, match: /^P-[A-Za-z0-9_-]{16}$/ },
  status: { type: String, enum: ['active', 'disabled'], default: 'active', required: true },
}, { timestamps: true, strict: 'throw', autoIndex: false, autoCreate: false });

affiliateReferralSchema.pre('validate', function generateReferralCode() {
  if (this.isNew) this.referralCode = `P-${crypto.randomBytes(CODE_BYTES).toString('base64url')}`;
});
affiliateReferralSchema.index({ affiliatePromotion: 1 }, { unique: true, name: 'uniq_affiliate_referral_promotion' });
affiliateReferralSchema.index({ referralCode: 1 }, { unique: true, name: 'uniq_affiliate_referral_code' });

module.exports = mongoose.models.AffiliateReferral || mongoose.model('AffiliateReferral', affiliateReferralSchema);
