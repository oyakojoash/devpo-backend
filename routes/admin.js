const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const { registerAdmin } = require('../controllers/admincontroller');
const { protectAdmin } = require('../middleware/protectAdmin');
const Admin = require('../models/adminmodels');
const Order = require('../models/Order');
const User = require('../models/User');
const Product = require('../models/Product');

// 🔐 Token Generator
const generateToken = (adminId) => {
  return jwt.sign({ id: adminId, role: 'admin' }, process.env.JWT_SECRET, {
    expiresIn: '7d',
  });
};

// ✅ Admin Registration
router.post('/register', registerAdmin);

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
    console.error('Login error:', err.message);
    res.status(500).json({ message: 'Server error' });
  }
});

// ✅ Admin Logout
router.post('/logout', (req, res) => {
  res.clearCookie('adminToken').json({ message: 'Admin logged out' });
});

// ✅ Admin: Create Product
router.post('/products', protectAdmin, async (req, res) => {
  try {
    const product = await Product.create(req.body);
    res.status(201).json(product);
  } catch (err) {
    console.error('Create product failed:', err);
    res.status(500).json({ message: 'Failed to create product' });
  }
});

// ✅ Check Admin Session
router.get('/me', protectAdmin, (req, res) => res.json(req.admin));

// ✅ Admin Dashboard Stats
router.get('/stats', protectAdmin, async (req, res) => {
  try {
    const totalUsers = await User.countDocuments();
    const totalOrders = await Order.countDocuments();
    const totalRevenue = await Order.aggregate([
      { $group: { _id: null, total: { $sum: "$totalPrice" } } }
    ]);
    const totalProducts = await Product.countDocuments();

    res.json({
      totalUsers,
      totalOrders,
      totalRevenue: totalRevenue[0]?.total || 0,
      totalProducts,
    });
  } catch (err) {
    console.error("Admin stats error:", err);
    res.status(500).json({ message: 'Failed to fetch stats' });
  }
});

// ✅ Admin: Fetch All Orders
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
  } catch (error) {
    console.error("Error fetching admin orders:", error);
    res.status(500).json({ message: 'Failed to fetch orders' });
  }
});

// ✅ Admin: Fetch All Users
router.get('/users', protectAdmin, async (req, res) => {
  try {
    const users = await User.find().select('-password');
    res.json(users);
  } catch (err) {
    console.error('Fetch users failed:', err);
    res.status(500).json({ message: 'Failed to fetch users' });
  }
});

// ✅ Admin: Delete User
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

// ✅ Admin: Fetch All Products
router.get('/products', protectAdmin, async (req, res) => {
  try {
    const products = await Product.find().sort({ createdAt: -1 });
    res.json(products);
  } catch (err) {
    console.error('Fetch products failed:', err);
    res.status(500).json({ message: 'Failed to fetch products' });
  }
});

module.exports = router;
