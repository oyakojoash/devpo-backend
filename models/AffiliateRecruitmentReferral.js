const crypto = require('node:crypto');
const mongoose = require('mongoose');

const CODE_BYTES = 12;
const affiliateRecruitmentReferralSchema = new mongoose.Schema({
  referrer: { type: mongoose.Schema.Types.ObjectId, ref: 'Affiliate', required: true, immutable: true },
  referralCode: { type: String, required: true, immutable: true, match: /^R-[A-Za-z0-9_-]{16}$/ },
  status: { type: String, enum: ['active', 'disabled'], default: 'active', required: true },
}, { timestamps: true, strict: 'throw', autoIndex: false, autoCreate: false });

affiliateRecruitmentReferralSchema.pre('validate', function generateReferralCode() {
  if (this.isNew) this.referralCode = `R-${crypto.randomBytes(CODE_BYTES).toString('base64url')}`;
});
affiliateRecruitmentReferralSchema.index({ referrer: 1 }, { unique: true, name: 'uniq_recruitment_referrer' });
affiliateRecruitmentReferralSchema.index({ referralCode: 1 }, { unique: true, name: 'uniq_recruitment_referral_code' });

module.exports = mongoose.models.AffiliateRecruitmentReferral || mongoose.model('AffiliateRecruitmentReferral', affiliateRecruitmentReferralSchema);
