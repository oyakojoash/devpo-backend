const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { protect } = require('../middleware/auth');
const nodemailer = require('nodemailer');

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

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER, // your email
    pass: process.env.EMAIL_PASS, // app password or real password
  },
});

async function sendResetEmail(to, code) {
  await transporter.sendMail({
    from: `"MyApp Support" <${process.env.EMAIL_USER}>`,
    to,
    subject: 'Your Password Reset Code',
    text: `Your password reset code is: ${code}. It expires in 15 minutes.`,
  });
}
async function sendWelcomeEmail(to, fullName) {
  const subject = '🎉 Welcome to Our Platform!';
  const text = `Hi ${fullName || 'there'},\n\nWelcome to our community! We're thrilled to have you here.\n\nYou can now log in and explore your account.\n\nBest regards,\nThe Support Team`;

  const html = `
    <div style="font-family: Arial, sans-serif; background:#f9f9f9; padding:20px; border-radius:10px;">
      <h2 style="color:#007bff;">Welcome, ${fullName || 'Friend'} 🎉</h2>
      <p>We’re thrilled to have you join our platform. You can now log in and start exploring!</p>
      <p style="margin-top:20px;">With love, <br><b>The Support Team</b></p>
    </div>
  `;

  await transporter.sendMail({
    from: `"Support Team" <${process.env.EMAIL_USER}>`,
    to,
    subject,
    text,
    html,
  });
}


// ------------------- REGISTER -------------------
router.post('/register', async (req, res) => {
  const { fullName, email, password, phone } = req.body;

  try {
    const existing = await User.findOne({ email });
    if (existing) return res.status(400).json({ message: 'User already exists' });

    const hash = await bcrypt.hash(password, 10);
    const user = new User({ fullName, email, password: hash, phone });
    await user.save();
    
    sendWelcomeEmail(user.email, user.fullName).catch((err) =>
      console.error('Email send error:', err)
    );

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
    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) return res.status(404).json({ message: '❌ User not found' });

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    user.resetCode = code;
    user.resetCodeExpiry = Date.now() + 15 * 60 * 1000; // 15 mins
    await user.save();

    await sendResetEmail(email, code); // ✅ send code via email

    res.json({ message: '✅ Reset code sent to your email' });
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
