const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();
const Product = require('../models/Product');
const Vendor = require('../models/Vendor');
const MerchantProduct = require('../models/MerchantProduct');
const { body, validationResult } = require('express-validator');
const rateLimit = require('express-rate-limit');
const asyncHandler = require('express-async-handler');
const { protectAdmin } = require('../middleware/protectAdmin');

// The admin app shares this public catalog route. Expand its read view only when
// both the allowlisted admin origin and a valid adminToken are present.
const adminOrigins = new Set(['https://dvepoadmin.netlify.app', 'http://localhost:3000']);
const adminProductRead = (req, res, next) => {
  if (!req.cookies?.adminToken || !adminOrigins.has(req.get('origin'))) return next();
  return protectAdmin(req, res, next);
};

const createLimiter = rateLimit({ windowMs: 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false });
const productValidators = [
  body('name').isString().bail().trim().isLength({ min: 1, max: 160 }),
  body('price').isFloat({ min: 0 }).toFloat(),
  body('vendorId').isString().bail().trim().isLength({ min: 1, max: 100 }),
  body('image').isString().bail().trim().isLength({ min: 1, max: 255 }),
  body('description').optional().isString().bail().isLength({ max: 5000 }),
];
const escapedRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const PRODUCT_FIELDS = ['name', 'price', 'vendorId', 'image', 'description'];

const validateProductBody = (req, res, next) => {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
    return res.status(400).json({ message: 'Invalid product data' });
  }
  return next();
};

const parseBoundedInteger = (value, defaultValue, maximum) => {
  if (value === undefined) return { value: defaultValue };
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return { error: true };
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) return { error: true };
  return { value: parsed };
};

const productInputError = (error) => error?.name === 'ValidationError' || error?.name === 'CastError';
const productInput = (body) => ({
  name: body.name,
  price: body.price,
  vendorId: body.vendorId,
  image: body.image,
  description: body.description === undefined ? '' : body.description,
});

const isPublicImageReference = (value) => {
  if (typeof value !== 'string') return false;
  if (/^https?:\/\//i.test(value) || value.startsWith('/api/images/')) return true;
  if (!value.startsWith('/images/')) return false;
  const imageRoot = path.resolve(__dirname, '../public/images');
  const imagePath = path.resolve(imageRoot, value.slice('/images/'.length));
  return imagePath.startsWith(`${imageRoot}${path.sep}`) && fs.existsSync(imagePath) && fs.statSync(imagePath).isFile();
};

const publicLegacyProduct = (product) => ({
  ...product,
  sourceType: 'product',
  productType: 'retail',
  currency: 'KES',
  available: true,
  purchasable: true,
});

const publicMerchantProduct = (product, vendor) => {
  const images = (product.images || []).filter(isPublicImageReference);
  return {
    _id: `mp_${product._id}`,
    sourceType: 'merchantProduct',
    name: product.name,
    description: product.description || '',
    price: product.retail.price,
    currency: product.currency || 'KES',
    image: images[0] || '',
    images,
    vendorId: vendor.id,
    vendor: { id: vendor.id, name: vendor.name, logo: vendor.logo },
    category: product.category || '',
    productType: 'retail',
    available: product.status === 'active' && product.retail.stock > 0,
    purchasable: product.status === 'active' && product.retail.stock > 0,
    createdAt: product.createdAt,
  };
};

const publicProductFilter = (rawSearch, field = 'name') => rawSearch
  ? { [field]: { $regex: escapedRegex(rawSearch), $options: 'i' } }
  : {};

const countsBefore = (legacyTotal, merchantTotal, position) => {
  const paired = Math.min(legacyTotal, merchantTotal);
  const alternatingLength = paired * 2;
  if (position <= alternatingLength) {
    return { legacy: Math.ceil(position / 2), merchant: Math.floor(position / 2) };
  }
  const tail = Math.min(position - alternatingLength, Math.abs(legacyTotal - merchantTotal));
  return legacyTotal > merchantTotal
    ? { legacy: paired + tail, merchant: paired }
    : { legacy: paired, merchant: paired + tail };
};

const interleavePage = (legacyProducts, merchantProducts, start, count, legacyTotal, merchantTotal) => {
  const products = [];
  let legacyIndex = 0;
  let merchantIndex = 0;
  const paired = Math.min(legacyTotal, merchantTotal);
  for (let position = start; position < start + count; position += 1) {
    const isLegacy = position < paired * 2 ? position % 2 === 0 : legacyTotal > merchantTotal;
    if (isLegacy) {
      products.push(legacyProducts[legacyIndex++]);
    } else {
      products.push(merchantProducts[merchantIndex++]);
    }
  }
  return products.filter(Boolean);
};

router.get('/', adminProductRead, asyncHandler(async (req, res) => {
  const rawSearch = typeof req.query.search === 'string' ? req.query.search.trim() : '';
  if (rawSearch.length > 100) return res.status(400).json({ message: 'Search query is too long' });
  const parsedPage = parseBoundedInteger(req.query.page, 1, 10000);
  const parsedLimit = parseBoundedInteger(req.query.limit, 20, 50);
  if (parsedPage.error) return res.status(400).json({ message: 'Invalid page' });
  if (parsedLimit.error) return res.status(400).json({ message: 'Invalid limit' });
  const { value: page } = parsedPage;
  const { value: limit } = parsedLimit;
  const pageOffset = (page - 1) * limit;

  const rawCategory = typeof req.query.category === 'string' ? req.query.category.trim() : '';
  const storeId = typeof req.query.storeId === 'string' ? req.query.storeId.trim() :
    typeof req.query.vendorId === 'string' ? req.query.vendorId.trim() : '';
  if (rawCategory.length > 100 || (req.query.category !== undefined && !rawCategory)) {
    return res.status(400).json({ message: 'Invalid category filter' });
  }
  if (storeId.length > 100) return res.status(400).json({ message: 'Invalid store filter' });

  const visibleVendorIds = req.admin ? null : await Vendor.find(Vendor.publicMarketplaceFilter()).distinct('id');
  const scopedVendorIds = visibleVendorIds && storeId
    ? visibleVendorIds.filter((vendorId) => String(vendorId) === storeId)
    : visibleVendorIds;
  const filter = {
    ...(visibleVendorIds ? { vendorId: { $in: scopedVendorIds } } : storeId ? { vendorId: storeId } : {}),
    ...publicProductFilter(rawSearch),
    // The legacy Product schema has no category field; category-filtered
    // requests therefore include only MerchantProducts that define one.
    ...(rawCategory ? { _id: { $exists: false } } : {}),
  };
  const legacyTotal = await Product.countDocuments(filter);
  let merchantTotal = 0;
  let merchantProducts = [];
  let merchantFilter = null;
  let eligibleVendorByMerchant = new Map();
  if (!req.admin && visibleVendorIds?.length) {
    const linkedVendors = await Vendor.find({
      merchantId: { $exists: true, $ne: null },
    }).select('id name logo merchantId approvalStatus status').lean();
    const visibleVendorIdSet = new Set(visibleVendorIds.map(String));

    // MerchantProduct has no store reference. A Merchant linked to exactly one
    // public Vendor is unambiguous; multiple eligible stores remain hidden.
    const vendorsByMerchant = new Map();
    for (const vendor of linkedVendors) {
      const merchantId = String(vendor.merchantId);
      vendorsByMerchant.set(merchantId, [...(vendorsByMerchant.get(merchantId) || []), vendor]);
    }
    eligibleVendorByMerchant = new Map(
      [...vendorsByMerchant.entries()].filter(([, vendors]) =>
        vendors.length === 1 && visibleVendorIdSet.has(String(vendors[0].id)))
        .map(([merchantId, vendors]) => [merchantId, vendors[0]]),
    );
    if (storeId) {
      for (const [merchantId, vendor] of eligibleVendorByMerchant) {
        if (vendor.id !== storeId) eligibleVendorByMerchant.delete(merchantId);
      }
    }
    const merchantIds = [...eligibleVendorByMerchant.keys()];
    if (merchantIds.length) {
      merchantFilter = {
        merchant: { $in: merchantIds },
        model: 'retail',
        status: 'active',
        archivedAt: null,
        'retail.stock': { $gt: 0 },
        ...publicProductFilter(rawSearch),
        ...(rawCategory ? { category: rawCategory } : {}),
      };
      merchantTotal = await MerchantProduct.countDocuments(merchantFilter);
    }
  }

  const total = legacyTotal + merchantTotal;
  const pageLength = Math.min(limit, Math.max(0, total - pageOffset));
  let pageProducts = [];
  if (pageLength > 0) {
    const starts = countsBefore(legacyTotal, merchantTotal, pageOffset);
    const ends = countsBefore(legacyTotal, merchantTotal, pageOffset + pageLength);
    const legacyCount = ends.legacy - starts.legacy;
    const merchantCount = ends.merchant - starts.merchant;
    const reads = [];
    if (legacyCount > 0) {
      reads.push(Product.find(filter).select('name price image description vendorId')
        .sort({ createdAt: -1, _id: -1 }).skip(starts.legacy).limit(legacyCount).lean());
    } else reads.push(Promise.resolve([]));
    if (merchantCount > 0 && merchantFilter) {
      reads.push(MerchantProduct.find(merchantFilter)
        .select('name description category model status currency images retail merchant createdAt')
        .sort({ createdAt: -1, _id: -1 }).skip(starts.merchant).limit(merchantCount).lean());
    } else reads.push(Promise.resolve([]));
    const [legacyRows, merchantRows] = await Promise.all(reads);
    const publicLegacyRows = legacyRows.map(publicLegacyProduct);
    const publicMerchantRows = merchantRows.map((product) => publicMerchantProduct(
      product,
      eligibleVendorByMerchant.get(String(product.merchant)),
    ));
    pageProducts = interleavePage(
      publicLegacyRows, publicMerchantRows, pageOffset, pageLength, legacyTotal, merchantTotal,
    );
  }
  return res.json({ products: pageProducts, currentPage: page, totalPages: Math.ceil(total / limit), totalResults: total });
}));

router.get('/:id', adminProductRead, asyncHandler(async (req, res) => {
  const merchantMatch = /^mp_([0-9a-fA-F]{24})$/.exec(req.params.id);
  if (merchantMatch) {
    if (req.admin) return res.status(404).json({ message: 'Product not found' });
    const product = await MerchantProduct.findOne({
      _id: merchantMatch[1], model: 'retail', status: 'active', archivedAt: null, 'retail.stock': { $gt: 0 },
    }).select('name description category model status currency images retail merchant createdAt').lean();
    if (!product) return res.status(404).json({ message: 'Product not found' });
    const vendors = await Vendor.find({ merchantId: product.merchant })
      .select('id name logo merchantId').lean();
    if (vendors.length !== 1 || !await Vendor.exists({
      ...Vendor.publicMarketplaceFilter(), id: vendors[0].id,
    })) return res.status(404).json({ message: 'Product not found' });
    return res.json(publicMerchantProduct(product, vendors[0]));
  }
  if (!/^[0-9a-fA-F]{24}$/.test(req.params.id)) return res.status(400).json({ message: 'Invalid product ID' });
  const product = await Product.findById(req.params.id).lean();
  if (!product) return res.status(404).json({ message: 'Product not found' });
  if (!req.admin) {
    const visibleVendor = await Vendor.exists({
      ...Vendor.publicMarketplaceFilter(),
      id: product.vendorId,
    });
    if (!visibleVendor) return res.status(404).json({ message: 'Product not found' });
  }
  return res.json(publicLegacyProduct(product));
}));

router.post('/', protectAdmin, createLimiter, validateProductBody, productValidators, asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  const data = productInput(req.body);
  try {
    const vendor = await Vendor.exists({ id: data.vendorId });
    if (!vendor) return res.status(400).json({ message: 'Vendor not found' });
    const product = await Product.create(data);
    return res.status(201).json({ message: 'Product created', product });
  } catch (error) {
    if (productInputError(error)) return res.status(400).json({ message: 'Invalid product data' });
    console.error('Product creation failed:', error?.name || 'Error');
    return res.status(500).json({ message: 'Failed to create product' });
  }
}));

router.put('/:id', protectAdmin, [
  validateProductBody,
  body('name').optional().isString().bail().trim().isLength({ min: 1, max: 160 }),
  body('price').optional().isFloat({ min: 0 }).toFloat(),
  body('vendorId').optional().isString().bail().trim().isLength({ min: 1, max: 100 }),
  body('image').optional().isString().bail().trim().isLength({ min: 1, max: 255 }),
  body('description').optional().isString().bail().isLength({ max: 5000 }),
], asyncHandler(async (req, res) => {
  if (!/^[0-9a-fA-F]{24}$/.test(req.params.id)) return res.status(400).json({ message: 'Invalid product ID' });
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  const update = {};
  for (const key of PRODUCT_FIELDS) {
    if (req.body[key] !== undefined) update[key] = req.body[key];
  }
  try {
    if (update.vendorId !== undefined && !await Vendor.exists({ id: update.vendorId })) {
      return res.status(400).json({ message: 'Vendor not found' });
    }
    const product = await Product.findByIdAndUpdate(req.params.id, { $set: update }, { new: true, runValidators: true });
    if (!product) return res.status(404).json({ message: 'Product not found' });
    return res.json({ message: 'Product updated', product });
  } catch (error) {
    if (productInputError(error)) return res.status(400).json({ message: 'Invalid product data' });
    console.error('Product update failed:', error?.name || 'Error');
    return res.status(500).json({ message: 'Failed to update product' });
  }
}));

router.delete('/:id', protectAdmin, asyncHandler(async (req, res) => {
  if (!/^[0-9a-fA-F]{24}$/.test(req.params.id)) return res.status(400).json({ message: 'Invalid product ID' });
  const product = await Product.findByIdAndDelete(req.params.id);
  if (!product) return res.status(404).json({ message: 'Product not found' });
  return res.json({ message: 'Product deleted' });
}));

module.exports = router;
