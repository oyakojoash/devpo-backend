const crypto = require('crypto');
const express = require('express');
const argon2 = require('argon2');
const rateLimit = require('express-rate-limit');
const { body, validationResult } = require('express-validator');
const Affiliate = require('../models/Affiliate');
const AffiliateSession = require('../models/AffiliateSession');
const emailService = require('../services/emailService');
const { protectAffiliate } = require('../middleware/protectAffiliate');

const SESSION_AGE_MS = AffiliateSession.MAX_SESSION_AGE_MS;
const RESET_CODE_AGE_MS = 15 * 60 * 1000;
const DUMMY_PASSWORD_HASH = '$argon2id$v=19$m=65536,p=4,t=3$w513SK/L4t9TdroXcTe8NA$M1+z58Eqp+fEzSvVCuuNMy30kW1kZXC6f51HRAXL+7k';
const registrationLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 5, standardHeaders: true, legacyHeaders: false });
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false });
const recoveryLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 5, standardHeaders: true, legacyHeaders: false });

const cookieOptions = (nodeEnv = process.env.NODE_ENV) => ({
  httpOnly: true,
  secure: nodeEnv === 'production',
  sameSite: nodeEnv === 'production' ? 'none' : 'lax',
  path: '/',
  maxAge: SESSION_AGE_MS,
});
const normalizeEmail = (value) => String(value || '').trim().toLowerCase();
const normalizePhone = (value) => Affiliate.normalizePhone(value);
const hashResetCode = (code) => crypto.createHash('sha256').update(code).digest('hex');
const safeAffiliate = (affiliate) => ({
  id: String(affiliate._id), name: affiliate.name, email: affiliate.email,
  phone: affiliate.phone || '', status: affiliate.status,
  createdAt: affiliate.createdAt, updatedAt: affiliate.updatedAt,
});
const validationFailed = (req, res) => {
  const result = validationResult(req);
  if (result.isEmpty()) return false;
  res.status(400).json({ message: 'Invalid request', errors: result.array() });
  return true;
};

const createAffiliateAuthRouter = ({
  AffiliateModel = Affiliate, AffiliateSessionModel = AffiliateSession, argon2Module = argon2,
  email = emailService, protect = protectAffiliate,
  registrationRateLimit = registrationLimiter, loginRateLimit = loginLimiter, recoveryRateLimit = recoveryLimiter,
  randomBytes = crypto.randomBytes, randomInt = crypto.randomInt, now = () => new Date(),
  nodeEnv = process.env.NODE_ENV, logger = console,
} = {}) => {
  const router = express.Router();

  const makeSession = async (affiliate) => {
    const token = randomBytes(32).toString('base64url');
    const currentTime = now();
    await AffiliateSessionModel.create({
      affiliate: affiliate._id,
      tokenHash: crypto.createHash('sha256').update(token).digest('hex'),
      expiresAt: new Date(currentTime.getTime() + SESSION_AGE_MS),
      createdAt: currentTime, updatedAt: currentTime, revokedAt: null,
    });
    return token;
  };

  router.post('/register', registrationRateLimit, [
    body('name').isString().trim().isLength({ min: 2, max: 100 }),
    body('email').isString().trim().isEmail().isLength({ max: 254 }),
    body('phone').optional({ values: 'falsy' }).isString().isLength({ max: 30 }).custom((value) => /^\+?\d{7,15}$/.test(normalizePhone(value))),
    body('password').isString().isLength({ min: 8, max: 128 }),
  ], async (req, res, next) => {
    if (validationFailed(req, res)) return;
    const { name } = req.body;
    const emailAddress = normalizeEmail(req.body.email);
    const phone = normalizePhone(req.body.phone);
    try {
      const passwordHash = await argon2Module.hash(req.body.password, { type: argon2Module.argon2id });
      let affiliate;
      try {
        affiliate = await AffiliateModel.create({ name: name.trim(), email: emailAddress, phone, passwordHash, status: 'active' });
      } catch (error) {
        if (error?.code === 11000 && (error.keyPattern?.email || error.keyValue?.email)) {
          return res.status(409).json({ message: 'Email is already registered' });
        }
        throw error;
      }

      let token;
      try {
        token = await makeSession(affiliate);
      } catch (error) {
        try { await AffiliateModel.deleteOne({ _id: affiliate._id }); }
        catch (_cleanupError) { logger.error('Affiliate account cleanup failed'); }
        throw error;
      }
      res.cookie('affiliateToken', token, cookieOptions(nodeEnv));
      return res.status(201).json({ affiliate: safeAffiliate(affiliate) });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/login', loginRateLimit, [
    body('email').isString().trim().isEmail().isLength({ max: 254 }),
    body('password').isString().isLength({ min: 1, max: 128 }),
  ], async (req, res, next) => {
    if (validationFailed(req, res)) return;
    try {
      const affiliate = await AffiliateModel.findOne({ email: normalizeEmail(req.body.email) }).select('+passwordHash');
      let passwordMatches = false;
      try {
        passwordMatches = await argon2Module.verify(affiliate?.passwordHash || DUMMY_PASSWORD_HASH, req.body.password);
      } catch (_verifyError) { passwordMatches = false; }
      if (!affiliate || affiliate.status !== 'active' || !passwordMatches) {
        return res.status(401).json({ message: 'Invalid email or password' });
      }
      const token = await makeSession(affiliate);
      res.cookie('affiliateToken', token, cookieOptions(nodeEnv));
      return res.json({ affiliate: safeAffiliate(affiliate) });
    } catch (error) { return next(error); }
  });

  router.get('/me', protect, (req, res) => res.json({ affiliate: safeAffiliate(req.affiliate) }));

  router.patch('/me', protect, (req, res, next) => {
    const bodyObject = req.body && typeof req.body === 'object' && !Array.isArray(req.body);
    const fields = bodyObject ? Object.keys(req.body) : [];
    if (!bodyObject || fields.length === 0 || fields.some((field) => !['name', 'phone'].includes(field))) {
      return res.status(400).json({ message: 'Only name and phone can be updated' });
    }
    return next();
  }, [
    body('name').optional().isString().trim().isLength({ min: 2, max: 100 }),
    body('phone').optional().isString().isLength({ max: 30 })
      .custom((value) => {
        const normalized = normalizePhone(value);
        return !normalized || /^\+?\d{7,15}$/.test(normalized);
      })
      .withMessage('Enter a phone number with 7 to 15 digits, optionally prefixed by +'),
  ], async (req, res, next) => {
    if (validationFailed(req, res)) return;
    const updates = {};
    if (Object.hasOwn(req.body, 'name')) updates.name = req.body.name;
    if (Object.hasOwn(req.body, 'phone')) updates.phone = normalizePhone(req.body.phone);

    try {
      const affiliate = await AffiliateModel.findOneAndUpdate(
        { _id: req.affiliate._id },
        { $set: updates },
        { new: true, runValidators: true },
      );
      if (!affiliate) return res.status(404).json({ message: 'Affiliate account not found' });
      return res.json({ affiliate: safeAffiliate(affiliate) });
    } catch (error) { return next(error); }
  });

  router.post('/logout', async (req, res, next) => {
    const token = req.cookies?.affiliateToken;
    try {
      if (typeof token === 'string' && token) {
        const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
        await AffiliateSessionModel.updateOne({ tokenHash, revokedAt: null }, { $set: { revokedAt: now() } });
      }
      const { maxAge: _maxAge, ...clearOptions } = cookieOptions(nodeEnv);
      res.clearCookie('affiliateToken', clearOptions);
      return res.json({ message: 'Logged out' });
    } catch (error) { return next(error); }
  });

  router.post('/forgot-password', recoveryRateLimit, [
    body('email').isString().trim().isEmail().isLength({ max: 254 }),
  ], async (req, res, next) => {
    if (validationFailed(req, res)) return;
    try {
      const affiliate = await AffiliateModel.findOne({ email: normalizeEmail(req.body.email) }).select('+resetCode +resetCodeExpiry');
      if (affiliate) {
        const code = randomInt(100000, 1000000).toString();
        affiliate.resetCode = hashResetCode(code);
        affiliate.resetCodeExpiry = new Date(now().getTime() + RESET_CODE_AGE_MS);
        await affiliate.save();
        try {
          await email.sendPasswordResetEmail(affiliate.email, code);
        } catch (error) {
          affiliate.resetCode = undefined;
          affiliate.resetCodeExpiry = undefined;
          try { await affiliate.save(); } catch (_cleanupError) { logger.error('Affiliate reset code cleanup failed'); }
          logger.error('Affiliate password recovery email failed', { name: error?.name || 'EmailDeliveryError' });
        }
      }
      return res.json({ message: 'If the account exists, a reset code has been sent.' });
    } catch (error) { return next(error); }
  });

  router.post('/reset-password', recoveryRateLimit, [
    body('email').isString().trim().isEmail().isLength({ max: 254 }),
    body('code').isString().matches(/^\d{6}$/),
    body('newPassword').isString().isLength({ min: 8, max: 128 }),
  ], async (req, res, next) => {
    if (validationFailed(req, res)) return;
    try {
      const affiliate = await AffiliateModel.findOne({ email: normalizeEmail(req.body.email) })
        .select('+resetCode +resetCodeExpiry +passwordHash');
      const submittedHash = hashResetCode(req.body.code);
      const validHash = affiliate?.resetCode && affiliate.resetCode.length === submittedHash.length &&
        crypto.timingSafeEqual(Buffer.from(affiliate.resetCode), Buffer.from(submittedHash));
      if (!affiliate || !validHash || !affiliate.resetCodeExpiry || affiliate.resetCodeExpiry.getTime() <= now().getTime()) {
        return res.status(400).json({ message: 'Invalid or expired reset code' });
      }
      affiliate.passwordHash = await argon2Module.hash(req.body.newPassword, { type: argon2Module.argon2id });
      affiliate.resetCode = undefined;
      affiliate.resetCodeExpiry = undefined;
      await affiliate.save();
      await AffiliateSessionModel.updateMany({ affiliate: affiliate._id, revokedAt: null }, { $set: { revokedAt: now() } });
      return res.json({ message: 'Password reset successful' });
    } catch (error) { return next(error); }
  });

  return router;
};

module.exports = { createAffiliateAuthRouter, cookieOptions, safeAffiliate, normalizeEmail, SESSION_AGE_MS, RESET_CODE_AGE_MS, DUMMY_PASSWORD_HASH };
