const express = require('express');
const router = express.Router();
const Product = require('../models/Product');
const { body, validationResult } = require('express-validator');
const rateLimit = require('express-rate-limit');
const {protect, isAdmin}= require('../middleware/auth'); // Create if missing
const asyncHandler = require('express-async-handler');

// 🔒 Placeholder admin check (expand if needed)

// ✅ Rate limiter for creation
const createLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10,
  message: 'Too many product creation attempts, please wait.',
});

// ✅ Validators for create and update
const productValidators = [
  body('name').notEmpty().withMessage('Name is required'),
  body('price').isNumeric().withMessage('Price must be a number'),
  body('image').notEmpty().withMessage('Image URL is required'),
  body('vendorId').notEmpty().withMessage('Vendor ID is required'),
  body('description').optional().isString().withMessage('Details must be text'),
];

// ✅ GET /api/products?search=&page=&limit=
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const search = req.query.search || '';
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;

    const query = { name: { $regex: search, $options: 'i' } };
    const total = await Product.countDocuments(query);

    const products = await Product.find(query)
      .skip((page - 1) * limit)
      .limit(limit);

    res.json({
      products,
      currentPage: page,
      totalPages: Math.ceil(total / limit),
      totalResults: total,
    });
  })
);

// ✅ GET /api/products/:id
const mongoose = require('mongoose'); // ensure this is imported at top

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: 'Invalid product ID' });
    }

    const product = await Product.findById(id);
    if (!product) return res.status(404).json({ message: 'Product not found' });

    res.json(product);
  })
);


// ✅ POST /api/products (admin only)
router.post(
  '/',
  protect,
  isAdmin,
  createLimiter,
  productValidators,
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty())
      return res.status(400).json({ errors: errors.array() });

    const product = new Product(req.body);
    await product.save();

    res.status(201).json({ message: 'Product created', product });
  })
);

// ✅ PUT /api/products/:id (admin only)
router.put(
  '/:id',
  protect,
  isAdmin,
  [
    body('name').optional().notEmpty().withMessage('Name is required'),
    body('price').optional().isNumeric().withMessage('Price must be a number'),
    body('image').optional().notEmpty().withMessage('Image URL is required'),
    body('vendorId').optional().notEmpty().withMessage('Vendor ID is required'),
    body('description').optional().isString().withMessage('Details must be text'),
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty())
      return res.status(400).json({ errors: errors.array() });

    const updated = await Product.findByIdAndUpdate(
      req.params.id,
      { $set: req.body },
      { new: true }
    );

    if (!updated) return res.status(404).json({ message: 'Product not found' });

    res.json({ message: 'Product updated', product: updated });
  })
);

// ✅ DELETE /api/products/:id (admin only)
router.delete(
  '/:id',
  protect,
  isAdmin,
  asyncHandler(async (req, res) => {
    const deleted = await Product.findByIdAndDelete(req.params.id);
    if (!deleted) return res.status(404).json({ message: 'Product not found' });
    res.json({ message: 'Product deleted' });
  })
);

module.exports = router;
