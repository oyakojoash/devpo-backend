// backend/routes/admin.js
const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');

const Admin = require('../models/adminmodels');
const User = require('../models/User');
const Order = require('../models/Order');
const Product = require('../models/Product');
const { registerAdmin } = require('../controllers/admincontroller');

// -------------------- Middleware --------------------
const protectAdmin = async (req, res, next) => {
  const token = req.cookies.adminToken;

  if (!token) {
    return res.status(401).json({ message: 'Admin not authenticated' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    if (decoded.role !== 'admin') {
      return res.status(403).json({ message: 'Invalid admin role' });
    }

    const admin = await Admin.findById(decoded.id).select('-password');
    if (!admin) {
      return res.status(403).json({ message: 'Admin not found' });
    }

    req.admin = admin;
    next();
  } catch (err) {
    return res.status(403).json({ message: 'Invalid or expired token' });
  }
};

// -------------------- Token Generator --------------------
const generateToken = (adminId) => {
  return jwt.sign({ id: adminId, role: 'admin' }, process.env.JWT_SECRET, {
    expiresIn: '7d',
  });
};

// -------------------- Admin Register --------------------
router.post('/register', registerAdmin);

// -------------------- Admin Login --------------------
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
      secure: process.env.NODE_ENV === 'production', // true on HTTPS
      sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    });

    res.json({ message: 'Admin login successful' });
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ message: 'Server error' });
  }
});

// -------------------- Admin Logout --------------------
router.post('/logout', (req, res) => {
  res.clearCookie('adminToken', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
  });
  res.json({ message: 'Admin logged out' });
});

// -------------------- Check Admin Session --------------------
router.get('/me', protectAdmin, (req, res) => {
  res.json(req.admin);
});

// -------------------- Admin Stats --------------------
router.get('/stats', protectAdmin, async (req, res) => {
  try {
    const totalUsers = await User.countDocuments();
    const totalOrders = await Order.countDocuments();
    const totalRevenueAgg = await Order.aggregate([{ $group: { _id: null, total: { $sum: "$totalPrice" } } }]);
    const totalProducts = await Product.countDocuments();

    res.json({
      totalUsers,
      totalOrders,
      totalRevenue: totalRevenueAgg[0]?.total || 0,
      totalProducts,
    });
  } catch (err) {
    console.error('Admin stats error:', err);
    res.status(500).json({ message: 'Failed to fetch stats' });
  }
});

// -------------------- Products --------------------
router.post('/products', protectAdmin, async (req, res) => {
  try {
    const product = await Product.create(req.body);
    res.status(201).json(product);
  } catch (err) {
    console.error('Create product failed:', err);
    res.status(500).json({ message: 'Failed to create product' });
  }
});

router.get('/products', protectAdmin, async (req, res) => {
  try {
    const products = await Product.find().sort({ createdAt: -1 });
    res.json(products);
  } catch (err) {
    console.error('Fetch products failed:', err);
    res.status(500).json({ message: 'Failed to fetch products' });
  }
});

// -------------------- Users --------------------
router.get('/users', protectAdmin, async (req, res) => {
  try {
    const users = await User.find().select('-password');
    res.json(users);
  } catch (err) {
    console.error('Fetch users failed:', err);
    res.status(500).json({ message: 'Failed to fetch users' });
  }
});

router.delete('/users/:id', protectAdmin, async (req, res) => {
  try {
    const user = await User.findByIdAndDelete(req.params.id);
    if (!user) return res.status(404).json({ message: 'User not found' });
    res.json({ message: 'User deleted' });
  } catch (err) {
    console.error('Delete user error:', err);
    res.status(500).json({ message: 'Failed to delete user' });
  }
});

// -------------------- Orders --------------------
router.get('/orders', protectAdmin, async (req, res) => {
  try {
    const orders = await Order.find()
      .populate('user', 'name email')
      .sort({ createdAt: -1 });

    const formatted = orders.map(order => ({
      _id: order._id,
      user: {
        name: order.user?.name || 'Unknown',
        email: order.user?.email || 'N/A'
      },
      totalPrice: order.totalPrice || 0,
      status: order.status || 'pending',
      createdAt: order.createdAt
    }));

    res.json(formatted);
  } catch (err) {
    console.error('Error fetching admin orders:', err);
    res.status(500).json({ message: 'Failed to fetch orders' });
  }
});

module.exports = router;
