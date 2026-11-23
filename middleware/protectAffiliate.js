const crypto = require('crypto');
const Affiliate = require('../models/Affiliate');
const AffiliateSession = require('../models/AffiliateSession');

const createProtectAffiliate = ({ AffiliateModel = Affiliate, AffiliateSessionModel = AffiliateSession, now = () => new Date() } = {}) => async (req, res, next) => {
  const token = req.cookies?.affiliateToken;
  if (typeof token !== 'string' || !token) return res.status(401).json({ message: 'Affiliate not authenticated' });

  try {
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const session = await AffiliateSessionModel.findOne({ tokenHash, revokedAt: null, expiresAt: { $gt: now() } })
      .select('_id affiliate createdAt expiresAt');
    if (!session) return res.status(401).json({ message: 'Affiliate not authenticated' });

    const createdAt = new Date(session.createdAt).getTime();
    const expiresAt = new Date(session.expiresAt).getTime();
    if (!Number.isFinite(createdAt) || !Number.isFinite(expiresAt) || createdAt > now().getTime() ||
      expiresAt <= now().getTime() || expiresAt - createdAt > AffiliateSessionModel.MAX_SESSION_AGE_MS) {
      return res.status(401).json({ message: 'Affiliate not authenticated' });
    }

    const affiliate = await AffiliateModel.findById(session.affiliate)
      .select('_id name email phone status createdAt updatedAt').lean();
    if (!affiliate || affiliate.status !== 'active') return res.status(401).json({ message: 'Affiliate not authenticated' });
    req.affiliate = affiliate;
    req.affiliateSessionId = String(session._id);
    return next();
  } catch (error) {
    return next(error);
  }
};

const protectAffiliate = createProtectAffiliate();
module.exports = { protectAffiliate, createProtectAffiliate };
