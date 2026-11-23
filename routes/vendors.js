const express = require('express');
const { protectAdmin } = require('../middleware/protectAdmin');
const router = express.Router();
const Vendor = require('../models/Vendor');
const Product = require('../models/Product'); // ✅ Added Product model import

const publicVendorFields = 'id name logo description';
const publicVendorProfileFields = `${publicVendorFields} merchantId`;

// Get marketplace-visible vendors only.
router.get('/', async (req, res) => {
  try {
    const vendors = await Vendor.find(Vendor.publicMarketplaceFilter())
      .select(publicVendorFields)
      .lean();
    res.json(vendors);
  } catch (err) {
    console.error('🔥 Failed to fetch vendors:', err);
    res.status(500).json({ message: 'Failed to load vendors' });
  }
});

// ✅ POST /api/vendors - Add a new vendor
router.post('/', async (req, res) => {
  const input = req.body;
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return res.status(400).json({ message: 'Invalid vendor application' });
  }

  const requiredFields = ['id', 'name', 'logo', 'description'];
  const optionalFields = ['businessName', 'contactEmail', 'contactPhone', 'address'];
  for (const field of requiredFields) {
    if (typeof input[field] !== 'string' || !input[field].trim()) {
      return res.status(400).json({ message: `A valid ${field} is required` });
    }
  }
  for (const field of optionalFields) {
    if (input[field] !== undefined && typeof input[field] !== 'string') {
      return res.status(400).json({ message: `Invalid ${field}` });
    }
  }

  try {
    const application = {
      id: input.id.trim(),
      name: input.name.trim(),
      logo: input.logo.trim(),
      description: input.description.trim(),
      approvalStatus: 'pending',
      status: 'suspended'
    };
    for (const field of optionalFields) {
      if (input[field] !== undefined) application[field] = input[field].trim();
    }

    const newVendor = new Vendor(application);
    const saved = await newVendor.save();
    res.status(201).json({
      _id: saved._id,
      id: saved.id,
      name: saved.name,
      logo: saved.logo,
      description: saved.description,
      approvalStatus: saved.approvalStatus,
      status: saved.status,
      createdAt: saved.createdAt,
      updatedAt: saved.updatedAt,
    });
  } catch (err) {
    console.error('❌ Failed to add vendor:', err);
    res.status(500).json({ message: 'Failed to add vendor' });
  }
});

// ✅ DELETE /api/vendors/:id - Delete vendor by Mongo _id
router.delete('/:id', protectAdmin, async (req, res) => {
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
      ...Vendor.publicMarketplaceFilter(),
      id: new RegExp(`^${requestedId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
    }).select(publicVendorProfileFields).lean();

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
    const vendor = await Vendor.findOne({
      ...Vendor.publicMarketplaceFilter(),
      id: new RegExp(`^${vendorId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
    }).select('id').lean();
    if (!vendor) return res.status(404).json({ message: 'Vendor not found' });

    const products = await Product.find({ vendorId: vendor.id });

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
