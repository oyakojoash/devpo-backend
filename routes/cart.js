const express = require('express');
const fs = require('fs');
const mongoose = require('mongoose');
const path = require('path');
const Cart = require('../models/Cart');
const Product = require('../models/Product');
const MerchantProduct = require('../models/MerchantProduct');
const Vendor = require('../models/Vendor');
const { protect } = require('../middleware/auth');

const router = express.Router();
const SOURCES = new Set(['product', 'merchantProduct']);

function isPublicMerchantImage(value) {
  if (typeof value !== 'string') return false;
  if (/^https?:\/\//i.test(value) || value.startsWith('/api/images/')) return true;
  if (!value.startsWith('/images/')) return false;
  const imageRoot = path.resolve(__dirname, '../public/images');
  const imagePath = path.resolve(imageRoot, value.slice('/images/'.length));
  return imagePath.startsWith(`${imageRoot}${path.sep}`) && fs.existsSync(imagePath) && fs.statSync(imagePath).isFile();
}

function normalizeIdentity(rawId, rawSource) {
  let productId = rawId;
  let sourceType = rawSource || 'product';
  if (typeof productId === 'string' && productId.startsWith('mp_')) {
    if (rawSource && rawSource !== 'merchantProduct') return null;
    sourceType = 'merchantProduct';
    productId = productId.slice(3);
  }
  if (!SOURCES.has(sourceType) || !mongoose.isValidObjectId(productId)) return null;
  return { productId: new mongoose.Types.ObjectId(productId), sourceType };
}

async function merchantStore(merchantId) {
  const linked = await Vendor.find({ merchantId }).select('id name logo approvalStatus status').lean();
  if (linked.length !== 1) return null;
  const store = linked[0];
  if (!await Vendor.exists({ _id: store._id, ...Vendor.publicMarketplaceFilter() })) return null;
  return store;
}

async function resolveProduct(identity) {
  if (identity.sourceType === 'product') {
    const product = await Product.findById(identity.productId).lean();
    if (!product) return null;
    const store = await Vendor.findOne({ id: product.vendorId, ...Vendor.publicMarketplaceFilter() })
      .select('id name logo').lean();
    return store ? { product, store } : null;
  }

  const product = await MerchantProduct.findOne({
    _id: identity.productId,
    model: 'retail',
    status: { $in: ['active', 'out of stock'] },
    archivedAt: null,
  }).lean();
  if (!product || !product.retail) return null;
  const store = await merchantStore(product.merchant);
  return store ? { product, store } : null;
}

function publicItem(item, resolved) {
  if (!resolved) {
    const sourceType = item.sourceType || 'product';
    const id = String(item.productId);
    return {
      ...(item._id ? { cartItemId: String(item._id) } : {}),
      sourceType,
      productId: { _id: sourceType === 'merchantProduct' ? `mp_${id}` : id, name: 'Unavailable product', image: '', price: 0 },
      quantity: item.quantity,
      available: false,
    };
  }
  const { product, store } = resolved;
  const sourceType = item.sourceType || 'product';
  const merchantImages = (product.images || []).filter(isPublicMerchantImage);
  const data = sourceType === 'merchantProduct'
    ? {
      _id: `mp_${product._id}`, name: product.name, description: product.description || '',
      price: product.retail.price, image: merchantImages[0] || '', images: merchantImages,
      vendorId: store.id, vendor: { id: store.id, name: store.name, logo: store.logo },
    }
    : { ...product, vendor: { id: store.id, name: store.name, logo: store.logo } };
  const available = sourceType !== 'merchantProduct'
    || (product.status === 'active' && product.retail.stock > 0);
  return {
    ...(item._id ? { cartItemId: String(item._id) } : {}),
    sourceType,
    productId: data,
    quantity: item.quantity,
    available,
    ...(sourceType === 'merchantProduct'
      ? { availableQuantity: product.status === 'active' ? product.retail.stock : 0 }
      : {}),
  };
}

async function hydrate(cart) {
  if (!cart) return [];
  return Promise.all(cart.items.map(async (item) => {
    const sourceType = item.sourceType || 'product';
    const identity = { sourceType, productId: item.productId };
    try {
      return publicItem(item, await resolveProduct(identity));
    } catch (_error) {
      return publicItem(item, null);
    }
  }));
}

router.get('/', protect, async (req, res) => {
  try {
    const cart = await Cart.findOne({ user: req.user._id });
    res.json({ items: await hydrate(cart) });
  } catch (err) {
    console.error('[GET /api/cart]', err.message);
    res.status(500).json({ message: 'Failed to load cart' });
  }
});

// `sourceType` is optional for legacy callers and defaults to Product.
router.post('/', protect, async (req, res) => {
  const { quantity } = req.body || {};
  const identity = normalizeIdentity(req.body?.productId, req.body?.sourceType);
  if (!identity || !Number.isSafeInteger(quantity) || quantity < 1) {
    return res.status(400).json({ message: 'Invalid product identity or quantity' });
  }

  try {
    const resolved = await resolveProduct(identity);
    if (!resolved) return res.status(409).json({ message: 'Product is unavailable or its store is not active' });
    if (identity.sourceType === 'merchantProduct' && resolved.product.status !== 'active') {
      return res.status(409).json({
        message: 'This Merchant product is currently unavailable',
        availableQuantity: 0,
        requestedQuantity: quantity,
      });
    }
    if (identity.sourceType === 'merchantProduct' && quantity > resolved.product.retail.stock) {
      const availableQuantity = resolved.product.retail.stock;
      return res.status(409).json({
        message: availableQuantity === 0
          ? 'This Merchant product is currently out of stock'
          : `Only ${availableQuantity} unit${availableQuantity === 1 ? '' : 's'} are currently available`,
        availableQuantity,
        requestedQuantity: quantity,
      });
    }

    let cart = await Cart.findOne({ user: req.user._id });
    if (!cart) cart = new Cart({ user: req.user._id, items: [] });
    const index = cart.items.findIndex((item) =>
      (item.sourceType || 'product') === identity.sourceType && String(item.productId) === String(identity.productId));
    if (index >= 0) cart.items[index].quantity = quantity;
    else cart.items.push({ ...identity, quantity });
    await cart.save();
    res.json({ items: await hydrate(cart) });
  } catch (err) {
    console.error('[POST /api/cart]', err.message);
    res.status(500).json({ message: 'Failed to update cart' });
  }
});

router.delete('/:productId', protect, async (req, res) => {
  const identity = normalizeIdentity(req.params.productId, req.query.sourceType);
  if (!identity) return res.status(400).json({ message: 'Invalid product identity' });
  try {
    const cart = await Cart.findOne({ user: req.user._id });
    if (!cart) return res.status(404).json({ message: 'Cart not found' });
    cart.items = cart.items.filter((item) =>
      !((item.sourceType || 'product') === identity.sourceType && String(item.productId) === String(identity.productId)));
    await cart.save();
    res.json({ items: await hydrate(cart) });
  } catch (err) {
    console.error('[DELETE /api/cart/:productId]', err.message);
    res.status(500).json({ message: 'Failed to remove item from cart' });
  }
});

module.exports = router;
