const express = require('express');
const mongoose = require('mongoose');
const Order = require('../models/Order');
const Product = require('../models/Product');
const Cart = require('../models/Cart');
const Vendor = require('../models/Vendor');
const MerchantProduct = require('../models/MerchantProduct');
const { protect, isAdmin } = require('../middleware/auth');
const { getUserOrders, getOrderById, cancelOrder } = require('../controllers/orderController');
const crypto = require('crypto');
const { notifyMerchants, notifyVendors, notifyCustomer } = require('../services/orderNotifications');

const router = express.Router();

router.post('/', protect, async (req, res) => {
  const lines = req.body?.products;
  if (!Array.isArray(lines) || lines.length === 0 || lines.length > 50) {
    return res.status(400).json({ message: 'Order must contain between 1 and 50 items' });
  }
  const quantities = new Map();
  for (const line of lines) {
    let sourceType = line?.sourceType || 'product';
    let rawId = String(line?.productId || '');
    if (rawId.startsWith('mp_')) {
      if (line?.sourceType && line.sourceType !== 'merchantProduct') return res.status(400).json({ message: 'Product source does not match its identity' });
      sourceType = 'merchantProduct'; rawId = rawId.slice(3);
    }
    const id = rawId.toLowerCase();
    const quantity = Number(line?.quantity);
    if (!['product', 'merchantProduct'].includes(sourceType) || !mongoose.isValidObjectId(id) || !Number.isInteger(quantity) || quantity < 1 || quantity > 99) {
      return res.status(400).json({ message: 'Invalid product or quantity' });
    }
    const key = `${sourceType}:${id}`;
    quantities.set(key, (quantities.get(key) || 0) + quantity);
    if (quantities.get(key) > 99) return res.status(400).json({ message: 'Item quantity exceeds the limit' });
  }

  const idempotencyKey = typeof req.get === 'function'
    ? req.get('Idempotency-Key')
    : req.headers?.['idempotency-key'];
  if (idempotencyKey !== undefined && !/^[A-Za-z0-9._:-]{16,128}$/.test(idempotencyKey)) {
    return res.status(400).json({ message: 'Invalid Idempotency-Key' });
  }
  const info = req.body.userInfo && typeof req.body.userInfo === 'object' ? req.body.userInfo : {};
  const userInfo = {
    name: String(info.name || req.user.fullName).trim().slice(0, 100),
    email: String(info.email || req.user.email).trim().slice(0, 254),
    phone: String(info.phone || req.user.phone || '').trim().slice(0, 30),
  };
  let shippingAddress;
  if (req.body.shippingAddress !== undefined) {
    const address = req.body.shippingAddress;
    const requiredAddressFields = ['recipient', 'phone', 'county', 'town', 'area', 'building'];
    if (!address || typeof address !== 'object' || Array.isArray(address)
      || requiredAddressFields.some((field) => typeof address[field] !== 'string' || !address[field].trim())
      || (address.instructions !== undefined && typeof address.instructions !== 'string')) {
      return res.status(400).json({ message: 'A complete shipping address is required' });
    }
    shippingAddress = {
      recipient: address.recipient.trim().slice(0, 100),
      phone: address.phone.trim().slice(0, 30),
      county: address.county.trim().slice(0, 100),
      town: address.town.trim().slice(0, 100),
      area: address.area.trim().slice(0, 150),
      building: address.building.trim().slice(0, 200),
      instructions: String(address.instructions || '').trim().slice(0, 500),
    };
  }
  const fingerprintData = {
    products: [...quantities.entries()].sort(([a], [b]) => a.localeCompare(b)),
    userInfo,
  };
  if (shippingAddress) fingerprintData.shippingAddress = shippingAddress;
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify(fingerprintData)).digest('hex');
  const findExisting = async () => Order.findOne({ user: req.user._id, idempotencyKey }).select('+idempotencyFingerprint');
  const clearPurchasedLines = async (order, session = null) => {
    const legacyProductIds = [...new Set(order.products.filter((item) => (item.sourceType || 'product') === 'product').map((item) =>
      String(item.productId?._id || item.productId)))].map((id) => new mongoose.Types.ObjectId(id));
    const merchantProductIds = [...new Set(order.products.filter((item) => item.sourceType === 'merchantProduct').map((item) =>
      String(item.productId?._id || item.productId)))].map((id) => new mongoose.Types.ObjectId(id));
    const orderId = new mongoose.Types.ObjectId(String(order._id));
    const filter = { user: req.user._id, processedOrderIds: { $ne: orderId } };
    const update = [{
      $set: {
        items: {
          $filter: {
            input: { $ifNull: ['$items', []] },
            as: 'item',
            cond: { $not: [{ $or: [
              { $and: [{ $eq: [{ $ifNull: ['$$item.sourceType', 'product'] }, 'product'] }, { $in: ['$$item.productId', legacyProductIds] }] },
              { $and: [{ $eq: ['$$item.sourceType', 'merchantProduct'] }, { $in: ['$$item.productId', merchantProductIds] }] },
            ] }] },
          },
        },
        processedOrderIds: {
          $concatArrays: [{ $ifNull: ['$processedOrderIds', []] }, [orderId]],
        },
      },
    }];
    try {
      await Cart.updateOne(filter, update, { upsert: true, ...(session ? { session } : {}) });
    } catch (error) {
      // A concurrent first checkout for this customer can win the unique-user
      // upsert. Retry against that cart without attempting another upsert.
      if (error.code !== 11000) throw error;
      await Cart.updateOne(filter, update, session ? { session } : {});
    }
  };
  const sendOrder = (status, order) => {
    const responseOrder = order.toObject ? order.toObject() : { ...order };
    delete responseOrder.idempotencyKey;
    delete responseOrder.idempotencyFingerprint;
    return res.status(status).json(responseOrder);
  };
  const recoverExisting = async (order) => {
    if (!order) return null;
    if (order.idempotencyFingerprint !== fingerprint) {
      return res.status(409).json({ message: 'Idempotency-Key was already used for a different order' });
    }
    try {
      await clearPurchasedLines(order);
      return sendOrder(200, order);
    } catch (error) {
      console.error('Order exists but cart clearing failed:', error.message);
      return res.status(500).json({
        message: 'Order was created but the cart could not be cleared; retry with the same Idempotency-Key',
        orderCreated: true,
        orderId: order._id,
        retryWithSameIdempotencyKey: true,
      });
    }
  };

  // An order carrying the key is the durable completion record. Replays can
  // finish cart cleanup even if the original request timed out after creation.
  if (idempotencyKey) {
    try {
      const existing = await findExisting();
      if (existing) return recoverExisting(existing);
    } catch (error) {
      console.error('Order idempotency lookup failed:', error.message);
      return res.status(500).json({ message: 'Failed to check order request status' });
    }
  }

  let order;
  let checkoutSession = null;
  const becameOutOfStock = new Set();
  const hasMerchantInventory = [...quantities.keys()].some((key) => key.startsWith('merchantProduct:'));
  try {
    const visibleVendorIds = await Vendor.find(Vendor.publicMarketplaceFilter()).distinct('id');
    const legacyIds = [...quantities.keys()].filter((key) => key.startsWith('product:')).map((key) => key.slice(8));
    const merchantIds = [...quantities.keys()].filter((key) => key.startsWith('merchantProduct:')).map((key) => key.slice(16));
    const [products, merchantProducts] = await Promise.all([
      legacyIds.length ? Product.find({ _id: { $in: legacyIds }, vendorId: { $in: visibleVendorIds } }).select('name price image vendorId').lean() : [],
      merchantIds.length ? MerchantProduct.find({ _id: { $in: merchantIds }, model: 'retail', status: 'active', archivedAt: null }).select('name currency images retail merchant').lean() : [],
    ]);
    if (products.length !== legacyIds.length || merchantProducts.length !== merchantIds.length) return res.status(400).json({ message: 'One or more products are unavailable' });
    const orderProducts = [];
    const merchantGroups = new Map();
    const vendorGroups = new Map();
    for (const product of products) {
      const index = orderProducts.length;
      orderProducts.push({ productId: product._id, name: product.name, price: product.price, quantity: quantities.get(`product:${product._id}`), sourceType: 'product', ownerType: 'vendor', ownerStoreId: product.vendorId, image: product.image, currency: 'KES' });
      const group = vendorGroups.get(String(product.vendorId)) || { vendorId: product.vendorId, productIndexes: [] };
      group.productIndexes.push(index); vendorGroups.set(String(product.vendorId), group);
    }
    for (const product of merchantProducts) {
      const stores = await Vendor.find({ merchantId: product.merchant, ...Vendor.publicMarketplaceFilter() }).select('_id id').lean();
      if (stores.length !== 1) return res.status(400).json({ message: 'One or more Merchant products are unavailable' });
      const quantity = quantities.get(`merchantProduct:${product._id}`);
      const index = orderProducts.length;
      const image = (product.images || [])[0] || '';
      orderProducts.push({ productId: product._id, name: product.name, price: product.retail.price, quantity, sourceType: 'merchantProduct', ownerType: 'merchant', ownerId: product.merchant, ownerStoreId: stores[0].id, image, currency: product.currency || 'KES' });
      const group = merchantGroups.get(String(product.merchant)) || { merchant: product.merchant, productIndexes: [], status: 'pending' };
      group.productIndexes.push(index); merchantGroups.set(String(product.merchant), group);
    }
    const totalPrice = orderProducts.reduce((sum, item) => sum + item.price * item.quantity, 0);
    const orderData = {
      user: req.user._id,
      userInfo,
      ...(shippingAddress ? { shippingAddress } : {}),
      products: orderProducts,
      merchantGroups: [...merchantGroups.values()],
      vendorGroups: [...vendorGroups.values()],
      totalPrice,
      status: 'pending',
    };
    if (idempotencyKey) {
      orderData.idempotencyKey = idempotencyKey;
      orderData.idempotencyFingerprint = fingerprint;
    }
    if (hasMerchantInventory) {
      checkoutSession = await mongoose.startSession();
      await checkoutSession.withTransaction(async () => {
        [order] = await Order.create([orderData], { session: checkoutSession });
        for (const item of orderProducts.filter((line) => line.sourceType === 'merchantProduct')) {
          const updated = await MerchantProduct.findOneAndUpdate(
            { _id: item.productId, merchant: item.ownerId, model: 'retail', status: 'active', 'retail.stock': { $gte: item.quantity } },
            [{ $set: { 'retail.stock': { $subtract: ['$retail.stock', item.quantity] }, status: { $cond: [{ $eq: [{ $subtract: ['$retail.stock', item.quantity] }, 0] }, 'out of stock', '$status'] } } }],
            { new: true, session: checkoutSession },
          );
          if (!updated) { const error = new Error('Requested stock is no longer available'); error.code = 'INSUFFICIENT_STOCK'; throw error; }
          if (updated.status === 'out of stock') becameOutOfStock.add(String(item.ownerId));
        }
        await clearPurchasedLines(order, checkoutSession);
      });
    } else {
      order = await Order.create(orderData);
    }
  } catch (error) {
    if (checkoutSession) await checkoutSession.endSession();
    if (error.code === 'INSUFFICIENT_STOCK') return res.status(409).json({ message: error.message });
    if (idempotencyKey && error.code === 11000) {
      try {
        const existing = await findExisting();
        if (existing) return recoverExisting(existing);
      } catch (lookupError) {
        console.error('Order idempotency recovery failed:', lookupError.message);
      }
    }
    console.error('Order creation failed:', error.message);
    return res.status(500).json({ message: 'Failed to place order' });
  }

  if (checkoutSession) await checkoutSession.endSession();
  if (order.merchantGroups?.length) await notifyMerchants(order, 'New order received', `A new customer order (${order._id}) is awaiting your decision.`);
  if (order.vendorGroups?.length) await notifyVendors(order, 'New order received', `A new customer order (${order._id}) has been placed.`);
  for (const merchant of becameOutOfStock) await notifyMerchants({ merchantGroups: [{ merchant }] }, 'Product out of stock', `A product in order ${order._id} reached zero stock.`);
  try {
    if (!hasMerchantInventory) await clearPurchasedLines(order);
  } catch (error) {
    console.error('Order created but cart clearing failed:', error.message);
    return res.status(500).json({
      message: 'Order was created but the cart could not be cleared',
      orderCreated: true,
      orderId: order._id,
      ...(idempotencyKey ? { retryWithSameIdempotencyKey: true } : {}),
    });
  }

  return sendOrder(201, order);
});

router.get('/my-orders', protect, getUserOrders);
router.get('/orders', protect, isAdmin, async (req, res) => {
  try {
    const orders = await Order.find({})
      .sort({ createdAt: -1 })
      .limit(100)
      .populate('user', 'fullName email phone')
      .populate('products.productId', 'name price image')
      .lean();
    return res.json(orders);
  } catch (error) {
    console.error('Admin order fetch failed:', error.message);
    return res.status(500).json({ message: 'Failed to fetch orders' });
  }
});

router.get('/:id', protect, getOrderById);
router.patch('/:id/cancel', protect, cancelOrder);
router.patch('/:id/payment-sent', protect, async (req, res) => {
  try {
    const order = await Order.findOne({ _id: req.params.id, user: req.user._id, merchantGroups: { $elemMatch: { $or: [{ paymentInstruction: { $exists: true, $ne: '' } }, { paymentLink: { $exists: true, $ne: '' } }] } } });
    if (!order) return res.status(404).json({ message: 'Order or payment instructions not found' });
    const now = new Date();
    order.merchantGroups.forEach((group) => {
      if ((group.paymentInstruction || group.paymentLink) && !group.paymentReceivedAt && !['rejected', 'cancelled'].includes(group.status)) {
        group.paymentSentAt = now;
        order.statusHistory.push({ status: 'payment_sent', actorType: 'customer', actorId: req.user._id, changedAt: now });
      }
    });
    order.markModified('merchantGroups');
    await order.save();
    await notifyMerchants(order, 'Payment Sent recorded', `The customer marked Payment Sent for order ${order._id}.`);
    return res.json({ order });
  } catch (_error) { return res.status(400).json({ message: 'Failed to record Payment Sent' }); }
});

router.get('/orders/:id', protect, isAdmin, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid order ID' });
  try {
    const order = await Order.findById(req.params.id)
      .populate('user', 'fullName email phone')
      .populate('products.productId', 'name price image')
      .lean();
    if (!order) return res.status(404).json({ message: 'Order not found' });
    return res.json(order);
  } catch (error) {
    console.error('Admin order lookup failed:', error.message);
    return res.status(500).json({ message: 'Failed to fetch order' });
  }
});

module.exports = router;
