const mongoose = require('mongoose');
const Affiliate = require('../models/Affiliate');
const AffiliatePromotion = require('../models/AffiliatePromotion');
const AffiliateReferral = require('../models/AffiliateReferral');
const AffiliateRecruitmentReferral = require('../models/AffiliateRecruitmentReferral');
const { hasExpectedDuplicateKey } = require('../utils/mongoDuplicateKey');

const MAX_CODE_ATTEMPTS = 3;

function referralError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function requireObjectId(value, label) {
  if (!mongoose.isObjectIdOrHexString(value)) throw referralError(`A valid ${label} is required`, 'INVALID_REFERRAL_REFERENCE');
  return value;
}

function isCodeCollision(error, indexName, fieldName) {
  return hasExpectedDuplicateKey(error, { keyPattern: { [fieldName]: 1 }, indexName });
}

async function createWithCodeRetry(Model, data, indexName, fieldName) {
  for (let attempt = 1; attempt <= MAX_CODE_ATTEMPTS; attempt += 1) {
    try {
      // Each create constructs a new document, so the schema hook generates a fresh code.
      return await Model.create(data);
    } catch (error) {
      if (!isCodeCollision(error, indexName, fieldName)) throw error;
      if (attempt === MAX_CODE_ATTEMPTS) {
        throw referralError(`Could not generate a unique referral code after ${MAX_CODE_ATTEMPTS} attempts`, 'REFERRAL_CODE_RETRY_EXHAUSTED');
      }
    }
  }
}

async function createProductReferral({ affiliateId, affiliatePromotionId, productId }, {
  AffiliatePromotionModel = AffiliatePromotion,
  AffiliateReferralModel = AffiliateReferral,
} = {}) {
  requireObjectId(affiliateId, 'affiliate');
  requireObjectId(affiliatePromotionId, 'affiliate promotion');
  requireObjectId(productId, 'product');

  const promotion = await AffiliatePromotionModel.findById(affiliatePromotionId).lean();
  if (!promotion) throw referralError('Affiliate promotion does not exist', 'AFFILIATE_PROMOTION_NOT_FOUND');
  if (String(promotion.affiliate) !== String(affiliateId)) {
    throw referralError('Affiliate promotion belongs to a different affiliate', 'AFFILIATE_PROMOTION_OWNERSHIP_MISMATCH');
  }
  if (String(promotion.product) !== String(productId)) {
    throw referralError('Affiliate promotion belongs to a different product', 'AFFILIATE_PROMOTION_PRODUCT_MISMATCH');
  }

  return createWithCodeRetry(AffiliateReferralModel, {
    affiliate: promotion.affiliate,
    affiliatePromotion: promotion._id,
    product: promotion.product,
  }, 'uniq_affiliate_referral_code', 'referralCode');
}

async function createRecruitmentReferral({ referrerId }, {
  AffiliateModel = Affiliate,
  AffiliateRecruitmentReferralModel = AffiliateRecruitmentReferral,
} = {}) {
  requireObjectId(referrerId, 'referrer');
  const affiliate = await AffiliateModel.findById(referrerId);
  if (!affiliate) throw referralError('Recruitment referrer does not exist', 'REFERRER_NOT_FOUND');

  return createWithCodeRetry(AffiliateRecruitmentReferralModel, {
    referrer: affiliate._id,
  }, 'uniq_recruitment_referral_code', 'referralCode');
}

module.exports = { MAX_CODE_ATTEMPTS, createProductReferral, createRecruitmentReferral, isCodeCollision };
