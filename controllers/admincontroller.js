const Admin = require('../models/adminmodels');
const jwt = require('jsonwebtoken');

// 🔐 Token generator
const generateToken = (adminId) => {
  return jwt.sign({ id: adminId, role: 'admin' }, process.env.JWT_SECRET, {
    expiresIn: '7d',
  });
};

// ✅ Admin registration logic
exports.registerAdmin = async (req, res) => {
  const { fullName, email, password } = req.body;

  try {
    const exists = await Admin.findOne({ email });
    if (exists) {
      return res.status(400).json({ message: 'Admin already exists' });
    }

    const admin = await Admin.create({ fullName, email, password });
    const token = generateToken(admin._id);

    res.cookie('adminToken', token, {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'strict',
  maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
});


    res.status(201).json({
      _id: admin._id,
      fullName: admin.fullName,
      email: admin.email,
      role: admin.role,
    });
  } catch (err) {
    console.error('Admin registration failed:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
};
