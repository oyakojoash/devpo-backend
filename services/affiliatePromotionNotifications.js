const Affiliate = require('../models/Affiliate');
const { sendEmail } = require('./orderNotifications');

async function notifyAffiliatePromotionWithdrawal(memberships, productName, AffiliateModel = Affiliate) {
  const affiliateIds = [...new Set((memberships || []).map((membership) => String(membership.affiliate)).filter(Boolean))];
  if (!affiliateIds.length) return;
  try {
    const affiliates = await AffiliateModel.find({ _id: { $in: affiliateIds } }).select('email').lean();
    await Promise.all(affiliates.map((affiliate) => sendEmail(
      affiliate.email,
      'Affiliate promotion withdrawn',
      `The merchant has withdrawn the product "${String(productName).slice(0, 160)}" from affiliate promotions. Your membership history has been preserved.`,
    )));
  } catch (error) {
    console.warn('Affiliate promotion notification lookup failed:', error.name || 'Error');
  }
}

module.exports = { notifyAffiliatePromotionWithdrawal };
