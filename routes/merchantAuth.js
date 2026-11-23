const crypto = require('crypto');
const express = require('express');
const argon2 = require('argon2');
const rateLimit = require('express-rate-limit');
const { body, validationResult } = require('express-validator');
const Merchant = require('../models/Merchant');
const MerchantCounter = require('../models/MerchantCounter');
const MerchantSession = require('../models/MerchantSession');
const Image = require('../models/Image');
const { protectMerchant } = require('../middleware/protectMerchant');

const SESSION_AGE_MS = MerchantSession.MAX_SESSION_AGE_MS;
const DUMMY_PASSWORD_HASH = '$argon2id$v=19$m=65536,p=4,t=3$w513SK/L4t9TdroXcTe8NA$M1+z58Eqp+fEzSvVCuuNMy30kW1kZXC6f51HRAXL+7k';
const passThrough = (_req, _res, next) => next();
const registrationLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 5, standardHeaders: true, legacyHeaders: false });
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false });

const cookieOptions = (nodeEnv = process.env.NODE_ENV) => ({
  httpOnly: true,
  secure: nodeEnv === 'production',
  sameSite: nodeEnv === 'production' ? 'none' : 'lax',
  path: '/',
  maxAge: SESSION_AGE_MS,
});

const safeMerchant = (merchant) => ({
  id: String(merchant._id),
  name: merchant.name,
  email: merchant.email,
  phone: merchant.phone,
  profileImage: merchant.profileImage || null,
  verification: { status: 'not_configured', verified: false },
  merchantId: merchant.merchantId,
  createdAt: merchant.createdAt,
  updatedAt: merchant.updatedAt,
});

const normalizeEmail = (value) => String(value || '').trim().toLowerCase();
const normalizePhone = (value) => Merchant.normalizePhone(value);
const validPhone = (value) => /^\+?\d{7,15}$/.test(normalizePhone(value));
const isMerchantIdentifierDuplicate = (error) => {
  if (error?.code !== 11000) return false;
  const fields = new Set([
    ...Object.keys(error.keyPattern || {}),
    ...Object.keys(error.keyValue || {}),
  ]);
  return fields.size > 0 && [...fields].every((field) => field === 'email' || field === 'phone');
};
const isMerchantIdDuplicate = (error) => {
  if (error?.code !== 11000) return false;
  const fields = new Set([
    ...Object.keys(error.keyPattern || {}),
    ...Object.keys(error.keyValue || {}),
  ]);
  return fields.size === 1 && fields.has('merchantId');
};
const safeErrorDetails = (error) => ({
  databaseCode: Number.isInteger(error?.code) ? error.code : 'UNSPECIFIED',
});
const validationFailed = (req, res) => {
  const result = validationResult(req);
  if (result.isEmpty()) return false;
  res.status(400).json({ message: 'Invalid request', errors: result.array() });
  return true;
};

const createMerchantAuthRouter = ({
  MerchantModel = Merchant,
  MerchantCounterModel = MerchantCounter,
  MerchantSessionModel = MerchantSession,
  ImageModel = Image,
  argon2Module = argon2,
  protect = protectMerchant,
  registrationRateLimit = registrationLimiter,
  loginRateLimit = loginLimiter,
  randomBytes = crypto.randomBytes,
  now = () => new Date(),
  nodeEnv = process.env.NODE_ENV,
  logger = console,
} = {}) => {
  const router = express.Router();
  const makeSession = async (merchant) => {
    const token = randomBytes(32).toString('base64url');
    const currentTime = now();
    const session = await MerchantSessionModel.create({
      merchant: merchant._id,
      tokenHash: crypto.createHash('sha256').update(token).digest('hex'),
      expiresAt: new Date(currentTime.getTime() + SESSION_AGE_MS),
      createdAt: currentTime,
      updatedAt: currentTime,
      revokedAt: null,
    });
    return { token, session };
  };

  router.post('/register', registrationRateLimit, [
    body('name').isString().trim().isLength({ min: 2, max: 100 }),
    body('email').isString().trim().isEmail().isLength({ max: 254 }),
    body('phone').isString().custom((value) => validPhone(value)),
    body('password').isString().isLength({ min: 8, max: 128 }),
  ], async (req, res, next) => {
    if (validationFailed(req, res)) return;
    const name = req.body.name.trim();
    const email = normalizeEmail(req.body.email);
    const phone = normalizePhone(req.body.phone);
    let passwordHash;
    try {
      passwordHash = await argon2Module.hash(req.body.password, { type: argon2Module.argon2id });
    } catch (error) {
      return next(error);
    }

    let merchant;
    for (let attempt = 0; attempt < 3 && !merchant; attempt += 1) {
      let merchantId;
      try {
        merchantId = await MerchantCounterModel.allocateNextMerchantId();
      } catch (error) {
        logger.error('Merchant ID allocation failed', safeErrorDetails(error));
        return res.status(500).json({ message: 'Registration failed' });
      }
      // The counter is deliberately provisioned by the legacy-ID migration.
      // Until then, do not allocate IDs that could conflict with existing accounts.
      if (!merchantId) {
        return res.status(503).json({ message: 'Merchant registration is temporarily unavailable' });
      }
      try {
        merchant = await MerchantModel.create({ name, email, phone, passwordHash, merchantId });
      } catch (error) {
        if (isMerchantIdentifierDuplicate(error)) {
          return res.status(409).json({ message: 'Email or phone number is already registered' });
        }
        if (isMerchantIdDuplicate(error)) continue;
        logger.error('Merchant account creation failed', safeErrorDetails(error));
        return res.status(500).json({ message: 'Registration failed' });
      }
    }
    if (!merchant) return res.status(503).json({ message: 'Merchant registration is temporarily unavailable' });

    let token;
    try {
      ({ token } = await makeSession(merchant));
    } catch (sessionError) {
      logger.error('Merchant session creation failed', safeErrorDetails(sessionError));
      try {
        const cleanup = await MerchantModel.deleteOne({ _id: merchant._id });
        if (cleanup?.deletedCount !== 1) {
          logger.error('Merchant account cleanup was not confirmed', { code: 'ACCOUNT_CLEANUP_NOT_CONFIRMED' });
        }
      } catch (cleanupError) {
        logger.error('Merchant account cleanup failed', safeErrorDetails(cleanupError));
      }
      return res.status(500).json({ message: 'Registration failed' });
    }

    res.cookie('merchantToken', token, cookieOptions(nodeEnv));
    return res.status(201).json({ merchant: safeMerchant(merchant) });
  });

  router.post('/login', loginRateLimit, [
    body('identifier').isString().trim().custom((value) =>
      value.includes('@') ? /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) : validPhone(value)),
    body('password').isString().isLength({ min: 1, max: 128 }),
  ], async (req, res, next) => {
    if (validationFailed(req, res)) return;
    const rawIdentifier = req.body.identifier.trim();
    const identifier = rawIdentifier.includes('@') ? normalizeEmail(rawIdentifier) : normalizePhone(rawIdentifier);
    try {
      const merchant = await MerchantModel.findOne(rawIdentifier.includes('@') ? { email: identifier } : { phone: identifier })
        .select('+passwordHash');
      let passwordMatches = false;
      try {
        passwordMatches = await argon2Module.verify(merchant?.passwordHash || DUMMY_PASSWORD_HASH, req.body.password);
      } catch (_verifyError) {
        passwordMatches = false;
      }
      if (!merchant || !passwordMatches) return res.status(401).json({ message: 'Invalid identifier or password' });
      const { token } = await makeSession(merchant);
      res.cookie('merchantToken', token, cookieOptions(nodeEnv));
      return res.json({ merchant: safeMerchant(merchant) });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/me', protect, (req, res) => res.json({ merchant: safeMerchant(req.merchant) }));

  router.put('/profile', protect, async (req, res) => {
    const body = req.body;
    const allowed = new Set(['name', 'email', 'phone', 'profileImage']);
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length === 0 || Object.keys(body).some((key) => !allowed.has(key))) {
      return res.status(400).json({ message: 'Profile contains unsupported or missing fields' });
    }
    const updates = {};
    if (Object.hasOwn(body, 'name')) {
      if (typeof body.name !== 'string' || body.name.trim().length < 2 || body.name.trim().length > 100) return res.status(400).json({ message: 'Name must be 2 to 100 characters' });
      updates.name = body.name.trim();
    }
    if (Object.hasOwn(body, 'email')) {
      if (typeof body.email !== 'string' || body.email.trim().length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email.trim())) return res.status(400).json({ message: 'Enter a valid email address' });
      updates.email = normalizeEmail(body.email);
    }
    if (Object.hasOwn(body, 'phone')) {
      if (typeof body.phone !== 'string' || !validPhone(body.phone)) return res.status(400).json({ message: 'Enter a valid phone number' });
      updates.phone = normalizePhone(body.phone);
    }
    if (Object.hasOwn(body, 'profileImage')) {
      let decodedImageReference = '';
      try { if (typeof body.profileImage === 'string') decodedImageReference = decodeURIComponent(body.profileImage); }
      catch (_error) { return res.status(400).json({ message: 'Choose a valid uploaded profile image' }); }
      if (body.profileImage !== null && (typeof body.profileImage !== 'string' || body.profileImage.length > 2048 || !/^\/api\/images\/[0-9a-f-]{36}\.(jpg|png|webp|gif)$/i.test(decodedImageReference))) {
        return res.status(400).json({ message: 'Choose a valid uploaded profile image' });
      }
      if (body.profileImage) {
        const filename = decodedImageReference.split('/').pop();
        const ownedImage = await ImageModel.findOne({ filename, ownerType: 'merchant', ownerId: req.merchant._id }).select('_id').lean();
        if (!ownedImage) return res.status(403).json({ message: 'Profile image must be uploaded by this Merchant' });
      }
      updates.profileImage = body.profileImage;
    }
    try {
      const merchant = await MerchantModel.findOneAndUpdate({ _id: req.merchant._id }, { $set: updates }, { new: true, runValidators: true })
        .select('_id name email phone profileImage merchantId createdAt updatedAt');
      if (!merchant) return res.status(404).json({ message: 'Merchant account not found' });
      return res.json({ merchant: safeMerchant(merchant) });
    } catch (error) {
      if (error?.code === 11000 && (error.keyPattern?.email || error.keyValue?.email)) return res.status(409).json({ message: 'An account with this email address already exists' });
      if (error?.name === 'ValidationError' || error?.name === 'CastError') return res.status(400).json({ message: 'Profile information is invalid' });
      return res.status(500).json({ message: 'Failed to update merchant profile' });
    }
  });

  router.put('/change-password', protect, async (req, res) => {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 2 || !Object.hasOwn(body, 'currentPassword') || !Object.hasOwn(body, 'newPassword')) {
      return res.status(400).json({ message: 'Provide your current password and a new password' });
    }
    if (typeof body.currentPassword !== 'string' || !body.currentPassword || body.currentPassword.length > 128 || typeof body.newPassword !== 'string' || body.newPassword.length < 8 || body.newPassword.length > 128) {
      return res.status(400).json({ message: 'New password must be 8 to 128 characters' });
    }
    try {
      const merchant = await MerchantModel.findById(req.merchant._id).select('+passwordHash');
      if (!merchant) return res.status(404).json({ message: 'Merchant account not found' });
      const matches = await argon2Module.verify(merchant.passwordHash, body.currentPassword).catch(() => false);
      if (!matches) return res.status(401).json({ message: 'Current password is incorrect' });
      merchant.passwordHash = await argon2Module.hash(body.newPassword, { type: argon2Module.argon2id });
      await merchant.save();
      await MerchantSessionModel.updateMany(
        { merchant: req.merchant._id, _id: { $ne: req.merchantSessionId }, revokedAt: null },
        { $set: { revokedAt: now() } },
      );
      return res.json({ message: 'Password changed. Other active sessions have been signed out.' });
    } catch (_error) {
      return res.status(500).json({ message: 'Failed to change password' });
    }
  });

  router.post('/logout', async (req, res, next) => {
    const token = req.cookies?.merchantToken;
    try {
      if (typeof token === 'string' && token) {
        const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
        await MerchantSessionModel.updateOne(
          { tokenHash, revokedAt: null },
          { $set: { revokedAt: now() } },
        );
      }
      const { maxAge: _maxAge, ...clearOptions } = cookieOptions(nodeEnv);
      res.clearCookie('merchantToken', clearOptions);
      return res.json({ message: 'Logged out' });
    } catch (error) {
      return next(error);
    }
  });

  return router;
};

module.exports = { createMerchantAuthRouter, cookieOptions, safeMerchant, normalizeEmail, normalizePhone, validPhone, SESSION_AGE_MS, DUMMY_PASSWORD_HASH };
