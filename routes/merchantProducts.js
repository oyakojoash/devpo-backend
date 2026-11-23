const express = require('express');
const asyncHandler = require('express-async-handler');
const MerchantProduct = require('../models/MerchantProduct');
const AffiliatePromotion = require('../models/AffiliatePromotion');
const Image = require('../models/Image');
const { notifyMerchants } = require('../services/orderNotifications');
const { notifyAffiliatePromotionWithdrawal } = require('../services/affiliatePromotionNotifications');
const { protectMerchant } = require('../middleware/protectMerchant');

const COMMON_FIELDS = new Set(['name', 'description', 'productClass', 'category', 'sku', 'status', 'currency', 'images']);
const MODEL_FIELDS = {
  retail: new Set(['price', 'stock']),
  wholesale: new Set(['unitPrice', 'minimumOrderQuantity', 'stock', 'unitsPerPackage', 'bulkPricing']),
  subscription: new Set(['price', 'billingInterval', 'duration', 'autoRenew', 'benefits']),
};
const REQUIRED_MODEL_FIELDS = {
  retail: ['price', 'stock'],
  wholesale: ['unitPrice', 'minimumOrderQuantity', 'stock'],
  subscription: ['price', 'billingInterval', 'duration', 'autoRenew'],
};
const OWNERSHIP_OR_SERVER_FIELDS = new Set([
  'id', '_id', 'merchant', 'merchantId', 'storeId', 'createdAt', 'updatedAt', 'archivedAt', '__v',
]);
const VALID_STATUSES = new Set(MerchantProduct.PRODUCT_STATUSES);
const VALID_MODELS = new Set(MerchantProduct.PRODUCT_MODELS);
const SORT_PIPELINES = {
  newest: { createdAt: -1, _id: -1 },
  name: { name: 1, _id: 1 },
  price: { _merchantSortPrice: 1, _id: 1 },
  stock: { _merchantSortStock: 1, _id: 1 },
};

const escapedRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const objectIdPattern = /^[0-9a-fA-F]{24}$/;

function serializeProduct(product) {
  const result = product?.toObject ? product.toObject() : { ...product };
  const id = String(result._id ?? result.id ?? '');
  delete result._id;
  delete result.id;
  delete result.merchant;
  delete result.__v;
  return { id, ...result };
}

function sendValidationError(error, res) {
  if (['ValidationError', 'CastError', 'StrictModeError'].includes(error?.name)) {
    return res.status(400).json({ message: 'Invalid product data' });
  }
  return null;
}

function validateBodyShape(body, { creating = false, selectedModel } = {}) {
  if (!isPlainObject(body)) return 'Invalid product data';

  for (const field of Object.keys(body)) {
    if (OWNERSHIP_OR_SERVER_FIELDS.has(field)) return `Field '${field}' is managed by the server`;
    if (field === 'model') {
      if (!creating) return 'A product model cannot be changed';
      if (!VALID_MODELS.has(body.model)) return 'Choose retail, wholesale, or subscription';
      continue;
    }
    if (COMMON_FIELDS.has(field)) continue;
    if (Object.hasOwn(MODEL_FIELDS, field)) {
      const expectedModel = creating ? body.model : selectedModel;
      if (field !== expectedModel) return `Field '${field}' does not match the product model`;
      if (!isPlainObject(body[field])) return `Field '${field}' must be an object`;
      if (Object.keys(body[field]).length === 0) return `Field '${field}' must contain product details`;
      for (const nestedField of Object.keys(body[field])) {
        if (!MODEL_FIELDS[field].has(nestedField)) return `Field '${field}.${nestedField}' is not supported`;
      }
      continue;
    }
    return `Field '${field}' is not supported`;
  }

  if (creating && (typeof body.name !== 'string' || !body.name.trim())) return 'Product name is required';
  if (creating && typeof body.model !== 'string') return 'Product model is required';
  if (!creating && Object.keys(body).length === 0) return 'At least one product field is required';

  for (const field of ['name', 'description', 'productClass', 'category', 'sku']) {
    if (body[field] !== undefined && typeof body[field] !== 'string') return `Field '${field}' must be a string`;
  }
  if (body.status !== undefined && (typeof body.status !== 'string' || !VALID_STATUSES.has(body.status))) {
    return 'Choose draft, active, inactive, or out of stock';
  }
  if (body.currency !== undefined && body.currency !== 'KES') return 'Currency must be KES';
  if (body.images !== undefined) {
    if (!Array.isArray(body.images) || body.images.length > 10 || body.images.some((image) =>
      typeof image !== 'string' || !MerchantProduct.isImageReference(image.trim()))) {
      return 'Images must contain up to 10 valid URL or path references';
    }
  }
  return null;
}

function validateModelNumbers(model, data, { creating = false } = {}) {
  if (data === undefined) return null;
  const positive = (value) => typeof value === 'number' && Number.isFinite(value) && value > 0;
  const positiveInteger = (value) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
  const stock = (value) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  const fields = Object.keys(data);
  const required = creating ? REQUIRED_MODEL_FIELDS[model] : [];
  if (required.some((field) => data[field] === undefined)) return `Required ${model} product fields are missing`;

  if (model === 'retail') {
    if (data.price !== undefined && !positive(data.price)) return 'Retail price must be greater than zero';
    if (data.stock !== undefined && !stock(data.stock)) return 'Retail stock must be a nonnegative integer';
  } else if (model === 'wholesale') {
    if (data.unitPrice !== undefined && !positive(data.unitPrice)) return 'Wholesale unit price must be greater than zero';
    if (data.minimumOrderQuantity !== undefined && !positiveInteger(data.minimumOrderQuantity)) return 'Minimum order quantity must be a positive integer';
    if (data.stock !== undefined && !stock(data.stock)) return 'Wholesale stock must be a nonnegative integer';
    if (data.unitsPerPackage !== undefined && data.unitsPerPackage !== null && !positiveInteger(data.unitsPerPackage)) return 'Units per package must be null or a positive integer';
    if (data.bulkPricing !== undefined) {
      if (!Array.isArray(data.bulkPricing) || data.bulkPricing.some((tier) =>
        !isPlainObject(tier) || Object.keys(tier).some((key) => !['minimumQuantity', 'unitPrice'].includes(key)) ||
        !positiveInteger(tier.minimumQuantity) || !positive(tier.unitPrice))) {
        return 'Bulk pricing tiers need a positive integer quantity and positive finite price';
      }
    }
  } else if (model === 'subscription') {
    if (data.price !== undefined && !positive(data.price)) return 'Subscription price must be greater than zero';
    if (data.billingInterval !== undefined && !MerchantProduct.BILLING_INTERVALS.includes(data.billingInterval)) return 'Choose a valid billing interval';
    if (data.duration !== undefined && !positiveInteger(data.duration)) return 'Subscription duration must be a positive integer';
    if (data.autoRenew !== undefined && typeof data.autoRenew !== 'boolean') return 'Auto-renew must be a boolean';
    if (data.benefits !== undefined && typeof data.benefits !== 'string') return 'Benefits must be a string';
  }
  return fields.length ? null : (creating ? `Required ${model} product fields are missing` : null);
}

async function validateMerchantImageOwnership(images, merchantId) {
  const filenames = [...new Set((images || []).map((value) => {
    try {
      const parsed = new URL(value, 'https://local.invalid');
      const marker = '/api/images/';
      const at = parsed.pathname.indexOf(marker);
      return at >= 0 ? decodeURIComponent(parsed.pathname.slice(at + marker.length)) : null;
    } catch { return null; }
  }).filter(Boolean))];
  if (!filenames.length) return true;
  const uploaded = await Image.find({ filename: { $in: filenames } }).select('filename ownerType ownerId').lean();
  return uploaded.every((image) => image.ownerType !== 'merchant' || String(image.ownerId) === String(merchantId));
}

function parseBoundedInteger(value, defaultValue, maximum) {
  if (value === undefined) return { value: defaultValue };
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return { error: true };
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) return { error: true };
  return { value: parsed };
}

const makeFilter = (merchantId, query) => {
  const filter = { merchant: merchantId };
  if (query.includeArchived !== 'true') filter.archivedAt = null;
  if (query.model !== undefined) filter.model = query.model;
  if (query.status !== undefined) filter.status = query.status;
  if (query.category !== undefined) filter.category = query.category.trim();
  if (query.q) {
    const search = new RegExp(escapedRegex(query.q.trim()), 'i');
    filter.$or = ['name', 'description', 'productClass', 'sku'].map((field) => ({ [field]: search }));
  }
  return filter;
};

function createMerchantProductsRouter({
  MerchantProductModel = MerchantProduct,
  AffiliatePromotionModel = AffiliatePromotion,
  notifyPromotionWithdrawal = notifyAffiliatePromotionWithdrawal,
  protect = protectMerchant,
  now = () => new Date(),
} = {}) {
  const router = express.Router();

  router.get('/', protect, asyncHandler(async (req, res) => {
    const { q, model, status, category, sort = 'newest', includeArchived } = req.query;
    if (Object.entries(req.query).some(([key, value]) => !['q', 'model', 'status', 'category', 'sort', 'page', 'limit', 'includeArchived'].includes(key) || typeof value !== 'string')) {
      return res.status(400).json({ message: 'Invalid product query' });
    }
    if (typeof q === 'string' && q.trim().length > 100) return res.status(400).json({ message: 'Search query is too long' });
    if (model !== undefined && !VALID_MODELS.has(model)) return res.status(400).json({ message: 'Invalid product model filter' });
    if (status !== undefined && !VALID_STATUSES.has(status)) return res.status(400).json({ message: 'Invalid product status filter' });
    if (category !== undefined && (!category.trim() || category.trim().length > 100)) return res.status(400).json({ message: 'Invalid category filter' });
    if (sort !== 'newest' && !Object.hasOwn(SORT_PIPELINES, sort)) return res.status(400).json({ message: 'Invalid sort order' });
    if (includeArchived !== undefined && !['true', 'false'].includes(includeArchived)) return res.status(400).json({ message: 'Invalid includeArchived value' });
    const parsedPage = parseBoundedInteger(req.query.page, 1, 10000);
    const parsedLimit = parseBoundedInteger(req.query.limit, 20, 50);
    if (parsedPage.error) return res.status(400).json({ message: 'Invalid page' });
    if (parsedLimit.error) return res.status(400).json({ message: 'Invalid limit' });

    const { value: page } = parsedPage;
    const { value: limit } = parsedLimit;
    const filter = makeFilter(req.merchant._id, req.query);
    const order = SORT_PIPELINES[sort];
    const pipeline = [
      { $match: filter },
      { $addFields: {
        _merchantSortPrice: { $ifNull: ['$retail.price', { $ifNull: ['$wholesale.unitPrice', '$subscription.price'] }] },
        _merchantSortStock: { $ifNull: ['$retail.stock', '$wholesale.stock'] },
      } },
      { $sort: order },
      { $skip: (page - 1) * limit },
      { $limit: limit },
      { $project: { _merchantSortPrice: 0, _merchantSortStock: 0 } },
    ];
    const [products, total] = await Promise.all([
      MerchantProductModel.aggregate(pipeline),
      MerchantProductModel.countDocuments(filter),
    ]);
    return res.json({
      items: products.map(serializeProduct),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  }));

  router.post('/', protect, asyncHandler(async (req, res) => {
    const shapeError = validateBodyShape(req.body, { creating: true });
    if (shapeError) return res.status(400).json({ message: shapeError });
    const modelError = validateModelNumbers(req.body.model, req.body[req.body.model], { creating: true });
    if (modelError) return res.status(400).json({ message: modelError });
    if (!await validateMerchantImageOwnership(req.body.images, req.merchant._id)) return res.status(403).json({ message: 'An image belongs to another Merchant' });

    const productData = { ...req.body };
    for (const field of ['name', 'description', 'productClass', 'category', 'sku']) {
      if (typeof productData[field] === 'string') productData[field] = productData[field].trim();
    }
    productData.currency = productData.currency || 'KES';
    productData.images = (productData.images || []).map((image) => image.trim());
    productData.merchant = req.merchant._id;

    try {
      const product = new MerchantProductModel(productData);
      await product.validate();
      await product.save();
      return res.status(201).json({ product: serializeProduct(product) });
    } catch (error) {
      const validationResponse = sendValidationError(error, res);
      if (validationResponse) return validationResponse;
      throw error;
    }
  }));

  router.get('/:productId', protect, asyncHandler(async (req, res) => {
    if (!objectIdPattern.test(req.params.productId)) return res.status(400).json({ message: 'Invalid product ID' });
    const product = await MerchantProductModel.findOne({ _id: req.params.productId, merchant: req.merchant._id }).lean();
    if (!product) return res.status(404).json({ message: 'Product not found' });
    return res.json({ product: serializeProduct(product) });
  }));

  router.patch('/:productId/inventory', protect, asyncHandler(async (req, res) => {
    if (!objectIdPattern.test(req.params.productId)) return res.status(400).json({ message: 'Invalid product ID' });
    if (!isPlainObject(req.body) || Object.keys(req.body).some((field) => field !== 'stock') ||
        typeof req.body.stock !== 'number' || !Number.isSafeInteger(req.body.stock) || req.body.stock < 0) {
      return res.status(400).json({ message: 'Stock must be a nonnegative integer' });
    }
    const ownerFilter = { _id: req.params.productId, merchant: req.merchant._id, archivedAt: null };
    const existing = await MerchantProductModel.findOne(ownerFilter).select('model').lean();
    if (!existing) return res.status(404).json({ message: 'Product not found' });
    if (!['retail', 'wholesale'].includes(existing.model)) {
      return res.status(400).json({ message: 'Subscription products do not have inventory' });
    }
    const stockPath = existing.model === 'retail' ? 'retail.stock' : 'wholesale.stock';
    const nextStatus = req.body.stock === 0 ? 'out of stock' : undefined;
    const product = await MerchantProductModel.findOneAndUpdate(
      { ...ownerFilter, model: existing.model },
      { $set: { [stockPath]: req.body.stock, ...(nextStatus ? { status: nextStatus } : {}) } },
      { new: true, runValidators: true },
    );
    if (!product) return res.status(404).json({ message: 'Product not found' });
    if (req.body.stock === 0 && existing.status !== 'out of stock') {
      await notifyMerchants({ merchantGroups: [{ merchant: req.merchant._id }] }, 'Product out of stock', `Your product "${product.name}" is now out of stock.`);
    }
    if (req.body.stock > 0 && product.status === 'out of stock') {
      product.status = 'active';
      await product.save();
      await notifyMerchants({ merchantGroups: [{ merchant: req.merchant._id }] }, 'Product stock replenished', `Your product "${product.name}" is available again.`);
    }
    return res.json({ product: serializeProduct(product) });
  }));

  router.patch('/:productId/affiliate-promotion', protect, asyncHandler(async (req, res) => {
    if (!objectIdPattern.test(req.params.productId)) return res.status(400).json({ message: 'Invalid product ID' });
    if (!isPlainObject(req.body) || Object.keys(req.body).length !== 1 || typeof req.body.affiliatePromotionEnabled !== 'boolean') {
      return res.status(400).json({ message: 'affiliatePromotionEnabled must be a boolean' });
    }
    const enabled = req.body.affiliatePromotionEnabled;
    const product = await MerchantProductModel.findOneAndUpdate(
      { _id: req.params.productId, merchant: req.merchant._id, archivedAt: null },
      { $set: { affiliatePromotionEnabled: enabled } },
      { new: true, runValidators: true },
    );
    if (!product) return res.status(404).json({ message: 'Product not found' });

    if (!enabled) {
      const affected = await AffiliatePromotionModel.find({ product: product._id, status: 'active' }).select('affiliate').lean();
      await AffiliatePromotionModel.updateMany(
        { product: product._id, status: 'active' },
        { $set: { status: 'withdrawn', withdrawnAt: now() } },
      );
      await notifyPromotionWithdrawal(affected, product.name);
    }
    return res.json({ product: serializeProduct(product) });
  }));

  router.patch('/:productId', protect, asyncHandler(async (req, res) => {
    if (!objectIdPattern.test(req.params.productId)) return res.status(400).json({ message: 'Invalid product ID' });
    const ownerFilter = { _id: req.params.productId, merchant: req.merchant._id, archivedAt: null };
    const product = await MerchantProductModel.findOne(ownerFilter);
    if (!product) return res.status(404).json({ message: 'Product not found' });

    const shapeError = validateBodyShape(req.body, { selectedModel: product.model });
    if (shapeError) return res.status(400).json({ message: shapeError });
    if (req.body.images !== undefined && !await validateMerchantImageOwnership(req.body.images, req.merchant._id)) return res.status(403).json({ message: 'An image belongs to another Merchant' });
    if (Object.hasOwn(req.body, product.model)) {
      const modelError = validateModelNumbers(product.model, req.body[product.model]);
      if (modelError) return res.status(400).json({ message: modelError });
    }

    try {
      const changes = { ...req.body };
      for (const field of ['name', 'description', 'productClass', 'category', 'sku']) {
        if (typeof changes[field] === 'string') changes[field] = changes[field].trim();
      }
      if (changes.images) changes.images = changes.images.map((image) => image.trim());
      const modelChanges = changes[product.model];
      delete changes[product.model];
      product.set(changes);
      if (modelChanges) {
        const currentModelData = product[product.model]?.toObject?.() || { ...product[product.model] };
        product.set(product.model, { ...currentModelData, ...modelChanges });
      }
      await product.save();
      return res.json({ product: serializeProduct(product) });
    } catch (error) {
      const validationResponse = sendValidationError(error, res);
      if (validationResponse) return validationResponse;
      throw error;
    }
  }));

  router.delete('/:productId', protect, asyncHandler(async (req, res) => {
    if (!objectIdPattern.test(req.params.productId)) return res.status(400).json({ message: 'Invalid product ID' });
    const product = await MerchantProductModel.findOneAndUpdate(
      { _id: req.params.productId, merchant: req.merchant._id, archivedAt: null },
      { $set: { archivedAt: now() } },
      { new: true, runValidators: true },
    );
    if (!product) return res.status(404).json({ message: 'Product not found' });
    return res.json({ product: serializeProduct(product), archived: true });
  }));

  return router;
}

module.exports = { createMerchantProductsRouter, serializeProduct, validateBodyShape, validateModelNumbers };
