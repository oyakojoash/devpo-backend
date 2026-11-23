// backend/routes/admin.js
const express = require('express');
const { body, validationResult } = require('express-validator');
const rateLimit = require('express-rate-limit');
const adminLoginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 8, standardHeaders: true, legacyHeaders: false });
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');

const Admin = require('../models/adminmodels');
const User = require('../models/User');
const Order = require('../models/Order');
const Product = require('../models/Product');
const Vendor = require('../models/Vendor');
const { registerAdmin } = require('../controllers/admincontroller');
const { protectAdmin } = require('../middleware/protectAdmin');
const ORDER_STATUSES = new Set(Order.schema.path('status').enumValues);
const ORDER_ID_PATTERN = /^[0-9a-f]{24}$/i;
const VENDOR_APPROVAL_STATUSES = new Set(['pending', 'approved', 'rejected']);
const ADMIN_VENDOR_FIELDS = '_id id name logo description businessName approvalStatus status createdAt updatedAt';
const productCreateValidators = [
  body('name').isString().bail().trim().isLength({ min: 1, max: 160 }),
  body('price').isFloat({ min: 0 }).toFloat(),
  body('vendorId').isString().bail().trim().isLength({ min: 1, max: 100 }),
  body('image').isString().bail().trim().isLength({ min: 1, max: 255 }),
  body('description').optional().isString().bail().isLength({ max: 5000 }),
];
const isProductInputError = (error) => error?.name === 'ValidationError' || error?.name === 'CastError';
const isObjectBody = (req, res, next) => {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
    return res.status(400).json({ message: 'Invalid product data' });
  }
  return next();
};
const productInput = (body) => ({
  name: body.name,
  price: body.price,
  vendorId: body.vendorId,
  image: body.image,
  description: body.description === undefined ? '' : body.description,
});

// -------------------- Token Generator --------------------
const generateToken = (adminId) => {
  return jwt.sign({ id: adminId, role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '7d' });
};

// -------------------- Admin Register --------------------
router.post('/register', protectAdmin, registerAdmin);

// -------------------- Admin Login --------------------
router.post('/login', adminLoginLimiter, async (req, res) => {
  const { email, password } = req.body;
  try {
    const admin = await Admin.findOne({ email });
    if (!admin || admin.role !== 'admin') return res.status(400).json({ message: 'Invalid credentials' });

    const isMatch = await bcrypt.compare(password, admin.password);
    if (!isMatch) return res.status(400).json({ message: 'Invalid credentials' });

    const token = generateToken(admin._id);

    res.cookie('adminToken', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production', // true on HTTPS
      sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    });

    res.json({ message: 'Admin login successful' });
  } catch (err) {
    console.error('Admin login error:', err);
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
router.get('/me', protectAdmin, (req, res) => res.json(req.admin));

// -------------------- Vendor Applications --------------------
router.get('/vendors', protectAdmin, async (req, res) => {
  const { approvalStatus } = req.query;
  if (approvalStatus !== undefined && !VENDOR_APPROVAL_STATUSES.has(approvalStatus)) {
    return res.status(400).json({ message: 'Invalid approval status' });
  }

  const page = req.query.page === undefined ? 1 : Number(req.query.page);
  const limit = req.query.limit === undefined ? 20 : Number(req.query.limit);
  if (!Number.isInteger(page) || page < 1 || page > 10000 ||
      !Number.isInteger(limit) || limit < 1 || limit > 100) {
    return res.status(400).json({ message: 'Invalid pagination values' });
  }

  try {
    const filter = approvalStatus ? { approvalStatus } : {};
    const [totalResults, vendors] = await Promise.all([
      Vendor.countDocuments(filter),
      Vendor.find(filter)
        .select(ADMIN_VENDOR_FIELDS)
        .sort({ createdAt: -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
    ]);
    return res.json({
      vendors,
      currentPage: page,
      totalPages: Math.ceil(totalResults / limit),
      totalResults,
    });
  } catch (error) {
    console.error('Fetch vendor applications failed:', error);
    return res.status(500).json({ message: 'Failed to fetch vendor applications' });
  }
});

async function setVendorDecision(req, res, approvalStatus, status, message) {
  if (!/^[0-9a-f]{24}$/i.test(req.params.id)) {
    return res.status(400).json({ message: 'Invalid vendor ID' });
  }
  try {
    const vendor = await Vendor.findByIdAndUpdate(
      req.params.id,
      { $set: { approvalStatus, status } },
      { new: true, runValidators: true }
    ).select(ADMIN_VENDOR_FIELDS).lean();
    if (!vendor) return res.status(404).json({ message: 'Vendor not found' });
    return res.json({ message, vendor });
  } catch (error) {
    console.error('Update vendor application failed:', error);
    return res.status(500).json({ message: 'Failed to update vendor application' });
  }
}

router.patch('/vendors/:id/approve', protectAdmin, (req, res) =>
  setVendorDecision(req, res, 'approved', 'active', 'Vendor approved')
);
router.patch('/vendors/:id/reject', protectAdmin, (req, res) =>
  setVendorDecision(req, res, 'rejected', 'suspended', 'Vendor rejected')
);

// -------------------- Admin Stats --------------------
router.get('/stats', protectAdmin, async (req, res) => {
  try {
    const totalUsers = await User.countDocuments();
    const totalOrders = await Order.countDocuments();
    const totalProducts = await Product.countDocuments();
    const totalRevenueAgg = await Order.aggregate([{ $group: { _id: null, total: { $sum: "$totalPrice" } } }]);

    res.json({
      totalUsers,
      totalOrders,
      totalProducts,
      totalRevenue: totalRevenueAgg[0]?.total || 0,
    });
  } catch (err) {
    console.error('Admin stats error:', err);
    res.status(500).json({ message: 'Failed to fetch stats' });
  }
});

// -------------------- Products --------------------
router.post('/products', protectAdmin, isObjectBody, productCreateValidators, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  const data = productInput(req.body);
  try {
    const vendor = await Vendor.exists({ id: data.vendorId });
    if (!vendor) return res.status(400).json({ message: 'Vendor not found' });
    const product = await Product.create(data);
    return res.status(201).json(product);
  } catch (error) {
    if (isProductInputError(error)) return res.status(400).json({ message: 'Invalid product data' });
    console.error('Create product failed:', error?.name || 'Error');
    return res.status(500).json({ message: 'Failed to create product' });
  }
});

router.get('/products', protectAdmin, async (req, res) => {
  try {
    const products = await Product.find().sort({ createdAt: -1 }).limit(100).lean();
    res.json(products);
  } catch (err) {
    console.error('Fetch products failed:', err);
    res.status(500).json({ message: 'Failed to fetch products' });
  }
});

// -------------------- Users --------------------
router.get('/users', protectAdmin, async (req, res) => {
  try {
    const users = await User.find().select('-password -resetCode -resetCodeExpiry').limit(100).lean();
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
    const orders = await Order.find().populate('user', 'fullName email').sort({ createdAt: -1 }).limit(100).lean();
    const formatted = orders.map(order => ({
      _id: order._id,
      user: { name: order.user?.fullName || order.userInfo?.name || 'Unknown', email: order.user?.email || order.userInfo?.email || 'N/A' },
      totalPrice: order.totalPrice || 0,
      status: order.status || 'pending',
      createdAt: order.createdAt,
      merchantGroups: order.merchantGroups || [],
      vendorGroups: order.vendorGroups || [],
    }));
    res.json(formatted);
  } catch (err) {
    console.error('Fetch orders failed:', err);
    res.status(500).json({ message: 'Failed to fetch orders' });
  }
});

router.get('/orders/:id', protectAdmin, async (req, res) => {
  try {
    if (!ORDER_ID_PATTERN.test(req.params.id)) {
      return res.status(400).json({ message: 'Invalid order ID' });
    }
    const order = await Order.findById(req.params.id)
      .populate('user', 'fullName email phone')
      .populate('products.productId', 'name price image');

    if (!order) {
      return res.status(404).json({ message: 'Order not found' });
    }

    const result = order.toObject();
    const customer = result.user || {};
    result.user = { ...customer, name: customer.fullName || result.userInfo?.name || 'N/A' };
    result.userInfo = {
      ...result.userInfo,
      name: result.userInfo?.name || customer.fullName || '',
      email: result.userInfo?.email || customer.email || '',
      phone: result.userInfo?.phone || customer.phone || '',
    };
    return res.json(result);
  } catch (err) {
    console.error('Fetch single order failed:', err);
    res.status(500).json({ message: 'Failed to fetch order' });
  }
});
 // backend/routes/admin.js

async function updateOrderStatus(req, res) {
  if (!ORDER_ID_PATTERN.test(req.params.id)) {
    return res.status(400).json({ message: 'Invalid order ID' });
  }
  const { status } = req.body || {};
  if (typeof status !== 'string' || !ORDER_STATUSES.has(status)) {
    return res.status(400).json({ message: 'Invalid status value' });
  }
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ message: 'Order not found' });
    if (order.merchantGroups?.length) return res.status(409).json({ message: 'Merchant-managed order statuses are controlled by their Merchant' });
    const allowed = {
      pending: ['accepted', 'processing', 'cancelled', 'rejected'],
      accepted: ['processing', 'rejected', 'cancelled'],
      processing: ['shipped', 'dispatched', 'delivered', 'cancelled'],
      shipped: ['delivered'], dispatched: ['delivered'],
      delivered: [], cancelled: [], rejected: [],
    };
    if (status !== order.status && !allowed[order.status]?.includes(status)) {
      return res.status(409).json({ message: 'Invalid order status transition' });
    }
    order.status = status;
    order.statusHistory = [...(order.statusHistory || []), { status, actorType: 'admin', actorId: req.admin._id, changedAt: new Date() }];
    await order.save();
    return res.json({ message: 'Order status updated', order });
  } catch (error) {
    console.error('Update order status failed:', error);
    return res.status(500).json({ message: 'Failed to update order status' });
  }
}

// Both methods retain their existing status-only request contract.
router.put('/orders/:id/status', protectAdmin, updateOrderStatus);
router.patch('/orders/:id/status', protectAdmin, updateOrderStatus);
  
router.delete('/orders/:id', protectAdmin, (_req, res) =>
  res.status(405).json({ message: 'Order history cannot be permanently deleted' }));

module.exports = router;
