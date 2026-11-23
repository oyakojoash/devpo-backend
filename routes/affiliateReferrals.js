const express = require('express');
const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const Affiliate = require('../models/Affiliate');
const AffiliatePromotion = require('../models/AffiliatePromotion');
const AffiliateReferral = require('../models/AffiliateReferral');
const AffiliateRecruitmentReferral = require('../models/AffiliateRecruitmentReferral');
const { protectAffiliate } = require('../middleware/protectAffiliate');
const { createProductReferral, createRecruitmentReferral } = require('../services/affiliateReferralService');
const { hasExpectedDuplicateKey } = require('../utils/mongoDuplicateKey');

const objectIdPattern = /^[0-9a-fA-F]{24}$/;

function validBodyObject(body) {
  return Boolean(body && typeof body === 'object' && !Array.isArray(body));
}

function serializeProductReferral(referral) {
  return {
    id: String(referral._id),
    referralCode: referral.referralCode,
    promotionId: String(referral.affiliatePromotion),
    productId: String(referral.product),
    status: referral.status,
  };
}

function serializeRecruitmentReferral(referral) {
  return {
    id: String(referral._id),
    referralCode: referral.referralCode,
    status: referral.status,
  };
}

function handleServiceError(error, res) {
  if (error?.code === 'INVALID_REFERRAL_REFERENCE') {
    return res.status(400).json({ message: 'Invalid referral request' });
  }
  if (['AFFILIATE_PROMOTION_NOT_FOUND', 'AFFILIATE_PROMOTION_OWNERSHIP_MISMATCH', 'AFFILIATE_PROMOTION_PRODUCT_MISMATCH'].includes(error?.code)) {
    return res.status(404).json({ message: 'Affiliate promotion not found' });
  }
  if (error?.code === 'REFERRER_NOT_FOUND') {
    return res.status(404).json({ message: 'Affiliate not found' });
  }
  if (error?.code === 'REFERRAL_CODE_RETRY_EXHAUSTED') {
    return res.status(503).json({ message: 'Unable to create referral at this time' });
  }
  return null;
}

function createAffiliateReferralsRouter({
  AffiliateModel = Affiliate,
  AffiliatePromotionModel = AffiliatePromotion,
  AffiliateReferralModel = AffiliateReferral,
  AffiliateRecruitmentReferralModel = AffiliateRecruitmentReferral,
  protect = protectAffiliate,
  createProductReferralService = createProductReferral,
  createRecruitmentReferralService = createRecruitmentReferral,
} = {}) {
  const router = express.Router();

  router.post('/', protect, asyncHandler(async (req, res) => {
    if (!validBodyObject(req.body) || Object.keys(req.body).length !== 1 ||
      typeof req.body.promotionId !== 'string' || !objectIdPattern.test(req.body.promotionId)) {
      return res.status(400).json({ message: 'A valid promotionId is required' });
    }
    if (!mongoose.isObjectIdOrHexString(req.affiliate?._id)) {
      return res.status(401).json({ message: 'Affiliate not authenticated' });
    }

    const promotionId = new mongoose.Types.ObjectId(req.body.promotionId);
    const promotion = await AffiliatePromotionModel.findById(promotionId).lean();
    if (!promotion) return res.status(404).json({ message: 'Affiliate promotion not found' });

    let referral;
    let created = true;
    try {
      referral = await createProductReferralService({
        affiliateId: req.affiliate._id,
        affiliatePromotionId: promotionId,
        productId: promotion.product,
      }, { AffiliatePromotionModel, AffiliateReferralModel });
    } catch (error) {
      if (hasExpectedDuplicateKey(error, {
        keyPattern: { affiliatePromotion: 1 },
        indexName: 'uniq_affiliate_referral_promotion',
      })) {
        // The unique promotion index resolves concurrent requests. Return that
        // winner to make retries idempotent without weakening the constraint.
        referral = await AffiliateReferralModel.findOne({ affiliatePromotion: promotionId }).lean();
        if (!referral || String(referral.affiliate) !== String(req.affiliate._id)) {
          return res.status(409).json({ message: 'Referral already exists' });
        }
        created = false;
      } else {
        const knownError = handleServiceError(error, res);
        if (knownError) return knownError;
        throw error;
      }
    }

    return res.status(created ? 201 : 200).json({ referral: serializeProductReferral(referral) });
  }));

  router.post('/recruitment', protect, asyncHandler(async (req, res) => {
    if (req.body !== undefined && (!validBodyObject(req.body) || Object.keys(req.body).length !== 0)) {
      return res.status(400).json({ message: 'Recruitment referral creation does not accept client-supplied identity fields' });
    }
    if (!mongoose.isObjectIdOrHexString(req.affiliate?._id)) {
      return res.status(401).json({ message: 'Affiliate not authenticated' });
    }

    let referral;
    let created = true;
    try {
      referral = await createRecruitmentReferralService({ referrerId: req.affiliate._id }, {
        AffiliateModel,
        AffiliateRecruitmentReferralModel,
      });
    } catch (error) {
      if (hasExpectedDuplicateKey(error, {
        keyPattern: { referrer: 1 },
        indexName: 'uniq_recruitment_referrer',
      })) {
        // The unique referrer index serializes concurrent requests.
        referral = await AffiliateRecruitmentReferralModel.findOne({ referrer: req.affiliate._id }).lean();
        if (!referral || String(referral.referrer) !== String(req.affiliate._id)) {
          return res.status(409).json({ message: 'Recruitment referral already exists' });
        }
        created = false;
      } else {
        const knownError = handleServiceError(error, res);
        if (knownError) return knownError;
        throw error;
      }
    }

    return res.status(created ? 201 : 200).json({ referral: serializeRecruitmentReferral(referral) });
  }));

  return router;
}

module.exports = { createAffiliateReferralsRouter, serializeProductReferral, serializeRecruitmentReferral };
