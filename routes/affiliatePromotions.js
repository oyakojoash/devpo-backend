const express = require('express');
const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const AffiliatePromotion = require('../models/AffiliatePromotion');
const MerchantProduct = require('../models/MerchantProduct');
const Merchant = require('../models/Merchant');
const Vendor = require('../models/Vendor');
const { protectAffiliate } = require('../middleware/protectAffiliate');

const objectIdPattern = /^[0-9a-fA-F]{24}$/;

function parseBoundedInteger(value, fallback, maximum) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= maximum ? parsed : null;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function availableProductFilter(extra = {}) {
  return {
    ...extra,
    affiliatePromotionEnabled: true,
    model: 'retail',
    status: 'active',
    archivedAt: null,
    'retail.stock': { $gt: 0 },
  };
}

async function buildVisibleStoreMap(productRows, MerchantModel, VendorModel) {
  const merchantIds = productRows
    ? [...new Set(productRows.map((product) => String(product.merchant)))]
    : null;
  if (merchantIds && !merchantIds.length) return new Map();
  const [merchants, vendors] = await Promise.all([
    MerchantModel.find(merchantIds ? { _id: { $in: merchantIds } } : {}).select('_id name').lean(),
    VendorModel.find({ ...(merchantIds ? { merchantId: { $in: merchantIds } } : {}), ...VendorModel.publicMarketplaceFilter() })
      .select('id name logo merchantId approvalStatus status').lean(),
  ]);
  const merchantMap = new Map(merchants.map((merchant) => [String(merchant._id), merchant]));
  const vendorsByMerchant = new Map();
  for (const vendor of vendors) {
    const key = String(vendor.merchantId);
    vendorsByMerchant.set(key, [...(vendorsByMerchant.get(key) || []), vendor]);
  }
  const visible = new Map();
  for (const merchantId of (merchantIds || [...vendorsByMerchant.keys()])) {
    const linked = vendorsByMerchant.get(merchantId) || [];
    const merchant = merchantMap.get(merchantId);
    // Match the public catalog: only one public Vendor can represent a MerchantProduct.
    if (merchant && linked.length === 1) visible.set(merchantId, { merchant, vendor: linked[0] });
  }
  return visible;
}

function serializeProduct(product, store, joined = false, membershipStatus = null) {
  return {
    id: String(product._id),
    name: product.name,
    description: product.description || '',
    category: product.category || '',
    price: product.retail?.price,
    currency: product.currency || 'KES',
    image: product.images?.[0] || null,
    images: product.images || [],
    merchant: {
      id: String(store.merchant._id),
      name: store.merchant.name,
      storeId: store.vendor.id,
      storeName: store.vendor.name,
      logo: store.vendor.logo,
    },
    joined,
    membershipStatus,
  };
}

function createAffiliatePromotionsRouter({
  AffiliatePromotionModel = AffiliatePromotion,
  MerchantProductModel = MerchantProduct,
  MerchantModel = Merchant,
  VendorModel = Vendor,
  protect = protectAffiliate,
  now = () => new Date(),
} = {}) {
  const router = express.Router();

  router.get('/catalog', protect, asyncHandler(async (req, res) => {
    if (Object.entries(req.query).some(([key, value]) => !['page', 'limit', 'search', 'category'].includes(key) || typeof value !== 'string')) {
      return res.status(400).json({ message: 'Invalid catalog query' });
    }
    const page = parseBoundedInteger(req.query.page, 1, 10000);
    const limit = parseBoundedInteger(req.query.limit, 20, 50);
    if (!page || !limit) return res.status(400).json({ message: 'Invalid page or limit' });
    const search = req.query.search ?? '';
    const category = req.query.category ?? '';
    if (search.length > 100 || category.length > 100) return res.status(400).json({ message: 'Invalid catalog query' });

    const stores = await buildVisibleStoreMap(null, MerchantModel, VendorModel);
    const merchantIds = [...stores.keys()];
    if (!merchantIds.length) return res.json({ items: [], pagination: { page, limit, total: 0, pages: 0 } });
    const extraFilter = { merchant: { $in: merchantIds } };
    if (search) extraFilter.name = { $regex: escapeRegExp(search), $options: 'i' };
    if (category) extraFilter.category = category;
    const filter = availableProductFilter(extraFilter);
    const [visibleProducts, total] = await Promise.all([
      MerchantProductModel.find(filter).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      MerchantProductModel.countDocuments(filter),
    ]);
    const memberships = visibleProducts.length
      ? await AffiliatePromotionModel.find({ affiliate: req.affiliate._id, product: { $in: visibleProducts.map((item) => item._id) } }).select('product status').lean()
      : [];
    const membershipMap = new Map(memberships.map((item) => [String(item.product), item.status]));
    return res.json({
      items: visibleProducts.map((product) => {
        const status = membershipMap.get(String(product._id)) || null;
        return serializeProduct(product, stores.get(String(product.merchant)), status === 'active', status);
      }),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  }));

  router.get('/', protect, asyncHandler(async (req, res) => {
    const memberships = await AffiliatePromotionModel.find({ affiliate: req.affiliate._id })
      .sort({ joinedAt: -1, _id: -1 }).lean();
    const productIds = [...new Set(memberships.map((item) => String(item.product)))];
    const products = productIds.length
      ? await MerchantProductModel.find({ _id: { $in: productIds } }).lean()
      : [];
    const productMap = new Map(products.map((product) => [String(product._id), product]));
    const stores = await buildVisibleStoreMap(products, MerchantModel, VendorModel);
    return res.json({ items: memberships.map((membership) => {
      const product = productMap.get(String(membership.product));
      const store = product && stores.get(String(product.merchant));
      return {
        id: String(membership._id),
        status: membership.status,
        joinedAt: membership.joinedAt,
        withdrawnAt: membership.withdrawnAt || null,
        product: product && store ? serializeProduct(product, store, membership.status === 'active', membership.status) : null,
      };
    }) });
  }));

  router.post('/', protect, asyncHandler(async (req, res) => {
    if (!req.body || Array.isArray(req.body) || typeof req.body !== 'object' ||
      Object.keys(req.body).length !== 1 || typeof req.body.productId !== 'string' || !objectIdPattern.test(req.body.productId)) {
      return res.status(400).json({ message: 'A valid productId is required' });
    }
    const productId = new mongoose.Types.ObjectId(req.body.productId);
    const product = await MerchantProductModel.findOne(availableProductFilter({ _id: productId })).lean();
    if (!product) return res.status(409).json({ message: 'Product is not eligible for affiliate promotion' });
    const stores = await buildVisibleStoreMap([product], MerchantModel, VendorModel);
    const store = stores.get(String(product.merchant));
    if (!store) return res.status(409).json({ message: 'Product is not eligible for affiliate promotion' });

    try {
      const membership = await AffiliatePromotionModel.create({
        affiliate: req.affiliate._id,
        product: product._id,
        status: 'active',
        joinedAt: now(),
        withdrawnAt: null,
      });
      // Recheck after insert to close the disable/join race. A concurrent disable
      // either sees this membership in its withdrawal update or this check withdraws it.
      const stillEligible = await MerchantProductModel.findOne(availableProductFilter({ _id: product._id })).select('_id').lean();
      const currentStores = stillEligible ? await buildVisibleStoreMap([product], MerchantModel, VendorModel) : new Map();
      if (!stillEligible || !currentStores.has(String(product.merchant))) {
        await AffiliatePromotionModel.updateOne(
          { _id: membership._id, status: 'active' },
          { $set: { status: 'withdrawn', withdrawnAt: now() } },
        );
        return res.status(409).json({ message: 'Product is no longer eligible for affiliate promotion' });
      }
      return res.status(201).json({
        membership: { id: String(membership._id), status: membership.status, joinedAt: membership.joinedAt, withdrawnAt: null },
        product: serializeProduct(product, store, true, 'active'),
      });
    } catch (error) {
      if (error?.code === 11000) return res.status(409).json({ message: 'You have already joined this promotion' });
      throw error;
    }
  }));

  return router;
}

module.exports = { createAffiliatePromotionsRouter, availableProductFilter, buildVisibleStoreMap, serializeProduct };
