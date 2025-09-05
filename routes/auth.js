const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { protect } = require('../middleware/auth');

const router = express.Router();

// ✅ Helper to set cookie safely on Render
const setTokenCookie = (res, token) => {
  // Backend cookie settings
res.cookie('token', token, {
  httpOnly: true,
  secure: true,       // must be true on HTTPS
  sameSite: 'None',   // must be None for cross-site
  maxAge: 24*60*60*1000
});

};

// ------------------- REGISTER -------------------
router.post('/register', async (req, res) => {
  const { fullName, email, password, phone } = req.body;

  try {
    const existing = await User.findOne({ email });
    if (existing) return res.status(400).json({ message: 'User already exists' });

    const hash = await bcrypt.hash(password, 10);
    const user = new User({ fullName, email, password: hash, phone });
    await user.save();

    res.status(201).json({ message: '✅ Registered successfully' });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ message: 'Server error during registration' });
  }
});

// ------------------- LOGIN -------------------
router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  try {
    const user = await User.findOne({ email });
    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(400).json({ message: '❌ Invalid credentials' });
    }

    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET || 'defaultsecret', {
      expiresIn: '1d',
    });

    setTokenCookie(res, token);

    res.json({ message: '✅ Login successful' });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ message: 'Server error during login' });
  }
});

// ------------------- LOGOUT -------------------
router.post('/logout', (req, res) => {
  res.clearCookie('token', {
    httpOnly: true,
    secure: true,
    sameSite:'None'
  });
  res.json({ message: '✅ Logged out' });
});

// ------------------- FORGOT PASSWORD -------------------
router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;
  try {
    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ message: '❌ User not found' });

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    user.resetCode = code;
    user.resetCodeExpiry = Date.now() + 15 * 60 * 1000; // 15 mins
    await user.save();

    console.log(`🔐 Reset code for ${email}: ${code}`);
    res.json({ message: '✅ Reset code sent to your email or phone' });
  } catch (err) {
    console.error('Forgot password error:', err);
    res.status(500).json({ message: 'Server error during code sending' });
  }
});

// ------------------- RESET PASSWORD -------------------
router.post('/reset-password', async (req, res) => {
  const { email, code, newPassword } = req.body;

  try {
    const user = await User.findOne({ email });
    if (!user || user.resetCode !== code || !user.resetCodeExpiry || user.resetCodeExpiry < Date.now()) {
      return res.status(400).json({ message: '❌ Invalid or expired code' });
    }

    user.password = await bcrypt.hash(newPassword, 10);
    user.resetCode = undefined;
    user.resetCodeExpiry = undefined;
    await user.save();

    res.json({ message: '✅ Password reset successful' });
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({ message: 'Server error during password reset' });
  }
});

// ------------------- GET CURRENT USER -------------------
router.get('/me', protect, async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select('-password');
    if (!user) return res.status(404).json({ message: '❌ User not found' });
    res.json(user);
  } catch (err) {
    console.error('Get user error:', err);
    res.status(500).json({ message: 'Failed to fetch user' });
  }
});

module.exports = router;
