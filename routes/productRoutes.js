const express = require('express');
const router = express.Router();
const Product = require('../models/Product');

// GET /api/products?search=&page=1&limit=20
router.get('/', async (req, res) => {
  try {
    // 1. Parse query params
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const search = req.query.search?.trim() || '';

    // 2. Build MongoDB filter (case-insensitive name match)
    const filter = search
      ? { name: { $regex: search, $options: 'i' } }
      : {};

    // 3. Count & fetch paginated products
    const totalItems = await Product.countDocuments(filter);
    const products = await Product.find(filter)
      .skip((page - 1) * limit)
      .limit(limit);

    // 4. Send response
    res.json({
      products,
      currentPage: page,
      totalPages: Math.ceil(totalItems / limit),
      totalItems,
    });
  } catch (err) {
    console.error('[GET /api/products] ❌ Error:', err.message);
    res.status(500).json({ error: 'Server error while fetching products' });
  }
});

module.exports = router;
