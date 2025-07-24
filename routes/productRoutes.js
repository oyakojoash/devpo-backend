const express = require('express');
const router = express.Router();
const Product = require('../models/Product');


router.get('/', async (req, res) => {
  try {
    // ── 1. Parse query params ───────────────────────────
    const page  = parseInt(req.query.page)  || 1;
    const limit = parseInt(req.query.limit) || 20;
    const search = req.query.search || '';

    // ── 2. Build MongoDB filter  (case-insensitive name search) ─
    const filter = {
      name: { $regex: search, $options: 'i' }
    };

    // ── 3. Count & fetch paginated documents ────────────
    const totalItems = await Product.countDocuments(filter);
    const products   = await Product.find(filter)
                                    .skip((page - 1) * limit)
                                    .limit(limit);

    // ── 4. Return paginated payload ─────────────────────
    res.json({
      products,
      currentPage: page,
      totalPages: Math.ceil(totalItems / limit),
      totalItems
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
