const express = require('express');
const router = express.Router();
const Admin = require('../models/adminmodels');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');

// 🔐 Generate token
const generateToken = (adminId) => {
  return jwt.sign({ id: adminId, role: 'admin' }, process.env.JWT_SECRET, {
    expiresIn: '7d',
  });
};

// ✅ Admin Login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  try {
    const admin = await Admin.findOne({ email });
    if (!admin || !(await bcrypt.compare(password, admin.password))) {
      return res.status(400).json({ message: 'Invalid credentials' });
    }

    const token = generateToken(admin._id);

    res.cookie('adminToken', token, {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production', // must be true on HTTPS
  sameSite: 'none', // allow cross-origin (Netlify → Railway)
  maxAge: 7 * 24 * 60 * 60 * 1000,
});

    res.json({ message: 'Admin login successful' });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// ✅ Admin Logout
router.post('/logout', (req, res) => {
  res.clearCookie('token').json({ message: 'Admin logged out' });
});

module.exports = router;
