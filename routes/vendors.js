const express = require('express');
const router = express.Router();
const Vendor = require('../models/Vendor');
const Product = require('../models/Product'); // ✅ Added Product model import

// ✅ Get ALL vendors
router.get('/', async (req, res) => {
  try {
    const vendors = await Vendor.find(); // No filter = all vendors
    res.json(vendors);
  } catch (err) {
    console.error('🔥 Failed to fetch vendors:', err);
    res.status(500).json({ message: 'Failed to load vendors' });
  }
});

// ✅ POST /api/vendors - Add a new vendor
router.post('/', async (req, res) => {
  try {
    const newVendor = new Vendor(req.body);
    const saved = await newVendor.save();
    res.status(201).json(saved);
  } catch (err) {
    console.error('❌ Failed to add vendor:', err);
    res.status(500).json({ message: 'Failed to add vendor' });
  }
});

// ✅ DELETE /api/vendors/:id - Delete vendor by Mongo _id
router.delete('/:id', async (req, res) => {
  try {
    const deleted = await Vendor.findByIdAndDelete(req.params.id);
    if (!deleted) return res.status(404).json({ message: 'Vendor not found' });
    res.json({ message: 'Vendor deleted' });
  } catch (err) {
    console.error('❌ Delete error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ✅ Get ONE vendor by :vendorId (case-insensitive)
router.get('/:vendorId', async (req, res) => {
  const requestedId = req.params.vendorId;
  console.log('📥 vendorId from URL:', requestedId);

  try {
    const vendor = await Vendor.findOne({
      id: new RegExp(`^${requestedId}$`, 'i') // Case-insensitive match
    });

    if (!vendor) {
      console.warn('❌ Not found in DB:', requestedId);
      return res.status(404).json({ message: 'Vendor not found' });
    }

    res.json(vendor);
  } catch (err) {
    console.error('🔥 DB Error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ✅ NEW: Get all products for a specific vendor
router.get('/:vendorId/products', async (req, res) => {
  const vendorId = req.params.vendorId;
  console.log('📦 Fetching products for vendor:', vendorId);

  try {
    // Find products that belong to this vendor
    const products = await Product.find({ vendorId });

    if (!products.length) {
      console.warn('⚠️ No products found for vendor:', vendorId);
      return res.status(404).json({ message: 'No products found for this vendor' });
    }

    res.json(products);
  } catch (err) {
    console.error('🔥 Error fetching vendor products:', err);
    res.status(500).json({ message: 'Failed to load vendor products' });
  }
});

module.exports = router;
