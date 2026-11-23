const { inspectCollectionIndexes } = require('./readOnlyIndexInspection');
const { hasEquivalentIndexDefinition } = require('./referralIndexDefinition');

const REQUIRED_INDEXES = {
  AffiliateReferral: [
    { name: 'uniq_affiliate_referral_promotion', key: { affiliatePromotion: 1 }, unique: true },
    { name: 'uniq_affiliate_referral_code', key: { referralCode: 1 }, unique: true },
  ],
  AffiliateRecruitmentReferral: [
    { name: 'uniq_recruitment_referrer', key: { referrer: 1 }, unique: true },
    { name: 'uniq_recruitment_referral_code', key: { referralCode: 1 }, unique: true },
  ],
};

async function ensureModelIndexes(Model, requiredIndexes) {
  const indexes = await inspectCollectionIndexes(Model);
  for (const required of requiredIndexes) {
    const ready = indexes.some((index) => hasEquivalentIndexDefinition(index, required));
    if (!ready) {
      const error = new Error(`Required index ${required.name} for ${Model.modelName} is missing or has unexpected options`);
      error.code = 'AFFILIATE_REFERRAL_INDEX_NOT_READY';
      throw error;
    }
  }
}

async function ensureAffiliateReferralIndexes(AffiliateReferralModel, RecruitmentReferralModel) {
  await Promise.all([
    ensureModelIndexes(AffiliateReferralModel, REQUIRED_INDEXES.AffiliateReferral),
    ensureModelIndexes(RecruitmentReferralModel, REQUIRED_INDEXES.AffiliateRecruitmentReferral),
  ]);
}

module.exports = { REQUIRED_INDEXES, ensureAffiliateReferralIndexes };
