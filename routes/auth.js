const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const User = require('../models/User');
const { protect } = require('../middleware/auth');
const { body, validationResult } = require('express-validator');
const nodemailer = require('nodemailer');
const emailService = require('../services/emailService');

const router = express.Router();
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false });
const recoveryLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 5, standardHeaders: true, legacyHeaders: false });
const registrationLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 5, standardHeaders: true, legacyHeaders: false });
const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS } });
const cookieOptions = () => ({
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
  path: '/',
  maxAge: 24 * 60 * 60 * 1000,
});
const hashResetCode = (code) => crypto.createHash('sha256').update(code).digest('hex');
const validationFailed = (req, res) => {
  const result = validationResult(req);
  if (result.isEmpty()) return false;
  res.status(400).json({ message: 'Invalid request', errors: result.array() });
  return true;
};

async function sendResetEmail(to, code) {
  return emailService.sendPasswordResetEmail(to, code);
}

router.post('/register', registrationLimiter, [
  body('fullName').trim().isLength({ min: 2, max: 100 }),
  body('email').trim().isEmail().isLength({ max: 254 }),
  body('password').isString().isLength({ min: 8, max: 128 }),
  body('phone').optional({ values: 'falsy' }).isString().isLength({ max: 30 }),
], async (req, res) => {
  if (validationFailed(req, res)) return;
  const fullName = req.body.fullName.trim();
  const email = req.body.email.trim().toLowerCase();
  try {
    const password = await bcrypt.hash(req.body.password, 12);
    await User.create({ fullName, email, password, phone: req.body.phone || '' });
    void transporter.sendMail({
      from: `"Devpo Support" <${process.env.EMAIL_USER}>`, to: email,
      subject: 'Welcome to Devpo', text: `Hi ${fullName}, welcome to Devpo.`,
    }).catch((error) => console.error('Welcome email failed:', error.message));
    return res.status(201).json({ message: 'Registered successfully' });
  } catch (error) {
    if (error.code === 11000) return res.status(409).json({ message: 'Email already registered' });
    console.error('Registration failed:', error.message);
    return res.status(500).json({ message: 'Registration failed' });
  }
});

router.post('/login', loginLimiter, [
  body('email').trim().isEmail().isLength({ max: 254 }),
  body('password').isString().isLength({ min: 1, max: 128 }),
], async (req, res) => {
  if (validationFailed(req, res)) return;
  try {
    const email = req.body.email.trim().toLowerCase();
    const user = await User.findOne({ email }).select('+password');
    if (!user || !(await bcrypt.compare(req.body.password, user.password))) {
      return res.status(401).json({ message: 'Invalid email or password' });
    }
    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '1d', algorithm: 'HS256' });
    res.cookie('token', token, cookieOptions());
    return res.json({ message: 'Login successful' });
  } catch (error) {
    console.error('Login failed:', error.message);
    return res.status(500).json({ message: 'Login failed' });
  }
});

router.post('/logout', (req, res) => {
  const { maxAge, ...options } = cookieOptions();
  res.clearCookie('token', options);
  return res.json({ message: 'Logged out' });
});

router.post('/forgot-password', recoveryLimiter, [body('email').trim().isEmail().isLength({ max: 254 })], async (req, res) => {
  if (validationFailed(req, res)) return;
  const email = req.body.email.trim().toLowerCase();
  try {
    const user = await User.findOne({ email });
    if (user) {
      const code = crypto.randomInt(100000, 1000000).toString();
      user.resetCode = hashResetCode(code);
      user.resetCodeExpiry = new Date(Date.now() + 15 * 60 * 1000);
      await user.save();
      try {
        await sendResetEmail(email, code);
      } catch (error) {
        // Do not leave an unusable code active when delivery failed.
        user.resetCode = undefined;
        user.resetCodeExpiry = undefined;
        try {
          await user.save();
        } catch (_cleanupError) {
          console.error('Password recovery token cleanup failed');
        }
        console.error('Password recovery email delivery failed:', error?.name || 'EmailDeliveryError');
        return res.status(503).json({ message: 'Unable to send password recovery email' });
      }
    }
    return res.json({ message: 'If the account exists, a reset code has been sent.' });
  } catch (error) {
    console.error('Password recovery failed:', error.message);
    return res.status(500).json({ message: 'Unable to process password recovery' });
  }
});

router.post('/reset-password', recoveryLimiter, [
  body('email').trim().isEmail().isLength({ max: 254 }),
  body('code').isString().matches(/^\d{6}$/),
  body('newPassword').isString().isLength({ min: 8, max: 128 }),
], async (req, res) => {
  if (validationFailed(req, res)) return;
  const email = req.body.email.trim().toLowerCase();
  try {
    const user = await User.findOne({ email }).select('+resetCode +resetCodeExpiry +password');
    const submittedHash = hashResetCode(req.body.code);
    const validHash = user?.resetCode && user.resetCode.length === submittedHash.length && crypto.timingSafeEqual(Buffer.from(user.resetCode), Buffer.from(submittedHash));
    if (!user || !validHash || !user.resetCodeExpiry || user.resetCodeExpiry.getTime() < Date.now()) {
      return res.status(400).json({ message: 'Invalid or expired reset code' });
    }
    user.password = await bcrypt.hash(req.body.newPassword, 12);
    user.resetCode = undefined;
    user.resetCodeExpiry = undefined;
    await user.save();
    return res.json({ message: 'Password reset successful' });
  } catch (error) {
    console.error('Password reset failed:', error.message);
    return res.status(500).json({ message: 'Password reset failed' });
  }
});

router.get('/me', protect, async (req, res) => {
  const user = await User.findById(req.user._id).select('-password -resetCode -resetCodeExpiry').lean();
  if (!user) return res.status(404).json({ message: 'User not found' });
  return res.json(user);
});

module.exports = router;
