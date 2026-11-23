const crypto = require('crypto');
const Merchant = require('../models/Merchant');
const MerchantSession = require('../models/MerchantSession');

const merchantAuthDiagnosticsEnabled =
  process.env.NODE_ENV === 'development' && process.env.MERCHANT_AUTH_DIAGNOSTICS === '1';

function logMerchantAuthDiagnostic(req, outcome, details = {}) {
  if (!merchantAuthDiagnosticsEnabled) return;

  console.info('[merchant-auth-diagnostic]', {
    method: req.method,
    path: `${req.baseUrl || ''}${req.route?.path || req.path}`,
    merchantTokenPresent: Boolean(req.cookies?.merchantToken),
    adminTokenPresent: Boolean(req.cookies?.adminToken),
    branch: 'merchant',
    outcome,
    ...details,
  });
}

const createProtectMerchant = ({
  MerchantModel = Merchant,
  MerchantSessionModel = MerchantSession,
  now = () => new Date(),
} = {}) => async (req, res, next) => {
  logMerchantAuthDiagnostic(req, 'guard_entered');
  const token = req.cookies?.merchantToken;
  if (typeof token !== 'string' || !token) {
    logMerchantAuthDiagnostic(req, 'rejected', { failure: 'missing_merchant_cookie' });
    return res.status(401).json({ message: 'Merchant not authenticated' });
  }

  let stage = 'session_lookup';
  try {
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const session = await MerchantSessionModel.findOne({
      tokenHash,
      revokedAt: null,
      expiresAt: { $gt: now() },
    }).select('_id merchant createdAt expiresAt');
    if (!session) {
      logMerchantAuthDiagnostic(req, 'rejected', { failure: 'session_lookup_failed' });
      return res.status(401).json({ message: 'Merchant not authenticated' });
    }
    logMerchantAuthDiagnostic(req, 'session_lookup_succeeded');

    const createdAt = new Date(session.createdAt).getTime();
    const expiresAt = new Date(session.expiresAt).getTime();
    let validationFailure = null;
    if (!Number.isFinite(createdAt) || !Number.isFinite(expiresAt)) {
      validationFailure = 'invalid_session_timestamps';
    } else if (createdAt > now().getTime()) {
      validationFailure = 'session_created_in_future';
    } else if (expiresAt <= now().getTime()) {
      validationFailure = 'session_expired';
    } else if (expiresAt - createdAt > MerchantSessionModel.MAX_SESSION_AGE_MS) {
      validationFailure = 'session_age_exceeds_maximum';
    }
    if (validationFailure) {
      logMerchantAuthDiagnostic(req, 'rejected', { failure: validationFailure });
      return res.status(401).json({ message: 'Merchant not authenticated' });
    }

    stage = 'merchant_lookup';
    const merchant = await MerchantModel.findById(session.merchant)
      .select('_id name email phone profileImage merchantId createdAt updatedAt')
      .lean();
    if (!merchant) {
      logMerchantAuthDiagnostic(req, 'rejected', { failure: 'merchant_record_not_found' });
      return res.status(401).json({ message: 'Merchant not authenticated' });
    }
    req.merchant = merchant;
    req.merchantSessionId = String(session._id);
    logMerchantAuthDiagnostic(req, 'authenticated');
    return next();
  } catch (error) {
    logMerchantAuthDiagnostic(req, 'middleware_error', { stage });
    return next(error);
  }
};

const protectMerchant = createProtectMerchant();
module.exports = { protectMerchant, createProtectMerchant };
