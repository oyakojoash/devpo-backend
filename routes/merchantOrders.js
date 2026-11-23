const express = require('express');
const mongoose = require('mongoose');
const Order = require('../models/Order');
const MerchantProduct = require('../models/MerchantProduct');
const { protectMerchant } = require('../middleware/protectMerchant');
const { notifyCustomer } = require('../services/orderNotifications');

const router = express.Router();
const transitions = {
  accepted: ['processing'],
  processing: ['dispatched'],
  dispatched: ['delivered'],
};

router.get('/', protectMerchant, async (req, res) => {
  try {
    const rows = await Order.find({ 'merchantGroups.merchant': req.merchant._id })
      .sort({ createdAt: -1 }).limit(100).lean();
    return res.json(rows.map((order) => ({
      ...order,
      products: order.products.filter((line) => String(line.ownerId) === String(req.merchant._id)),
      merchantGroups: order.merchantGroups.filter((group) => String(group.merchant) === String(req.merchant._id)),
    })));
  } catch (_error) { return res.status(500).json({ message: 'Failed to fetch Merchant orders' }); }
});

router.patch('/:orderId/decision', protectMerchant, async (req, res) => {
  const { decision, reason = '' } = req.body || {};
  if (!['accept', 'reject'].includes(decision) || (decision === 'reject' && (typeof reason !== 'string' || !reason.trim() || reason.length > 1000))) {
    return res.status(400).json({ message: 'Choose accept or provide a rejection reason' });
  }
  const session = await mongoose.startSession();
  let result;
  try {
    await session.withTransaction(async () => {
      const order = await Order.findOne({ _id: req.params.orderId, merchantGroups: { $elemMatch: { merchant: req.merchant._id, status: 'pending' } } }).session(session);
      if (!order) return;
      const group = order.merchantGroups.find((item) => String(item.merchant) === String(req.merchant._id));
      const nextStatus = decision === 'accept' ? 'accepted' : 'rejected';
      group.status = nextStatus;
      if (order.merchantGroups.length === 1 && order.vendorGroups.length === 0) order.status = nextStatus;
      order.statusHistory.push({ status: nextStatus, actorType: 'merchant', actorId: req.merchant._id, changedAt: new Date() });
      if (decision === 'reject') group.rejectionReason = reason.trim();
      if (decision === 'reject') {
        for (const index of group.productIndexes) {
          const line = order.products[index];
          if (line?.sourceType !== 'merchantProduct' || line.stockRestored) continue;
          line.stockRestored = true;
          const stockPath = 'retail.stock';
          await MerchantProduct.updateOne({ _id: line.productId, merchant: req.merchant._id }, [
            { $set: { [stockPath]: { $add: [`$${stockPath}`, line.quantity] }, status: { $cond: [{ $eq: [{ $add: [`$${stockPath}`, line.quantity] }, 0] }, '$status', { $cond: [{ $eq: ['$status', 'out of stock'] }, 'active', '$status'] }] } } },
          ], { session });
        }
      }
      order.markModified('products');
      order.markModified('merchantGroups');
      await order.save({ session });
      result = order.toObject();
    });
    if (!result) return res.status(409).json({ message: 'Order is not awaiting your decision' });
    const decisionLabel = decision === 'accept' ? 'accepted' : 'rejected';
    await notifyCustomer(result, `Merchant ${decisionLabel} your order`, `The Merchant has ${decisionLabel} order ${result._id}${decision === 'reject' ? `: ${reason.trim()}` : '.'}`);
    return res.json({ order: result });
  } catch (_error) { return res.status(500).json({ message: 'Failed to update order decision' }); }
  finally { await session.endSession(); }
});

router.patch('/:orderId/status', protectMerchant, async (req, res) => {
  const { status } = req.body || {};
  const session = await mongoose.startSession();
  let result;
  try {
    await session.withTransaction(async () => {
      const order = await Order.findOne({ _id: req.params.orderId, merchantGroups: { $elemMatch: { merchant: req.merchant._id } } }).session(session);
      if (!order) return;
      const group = order.merchantGroups.find((item) => String(item.merchant) === String(req.merchant._id));
      if (!transitions[group.status]?.includes(status)) return;
      group.status = status;
      if (order.merchantGroups.length === 1 && order.vendorGroups.length === 0) order.status = status;
      order.statusHistory.push({ status, actorType: 'merchant', actorId: req.merchant._id, changedAt: new Date() });
      await order.save({ session });
      result = order.toObject();
    });
    if (!result) return res.status(409).json({ message: 'Invalid order status transition' });
    await notifyCustomer(result, 'Order progress updated', `Order ${result._id} is now ${status}.`);
    return res.json({ order: result });
  } catch (_error) { return res.status(500).json({ message: 'Failed to update order status' }); }
  finally { await session.endSession(); }
});

router.patch('/:orderId/payment-instructions', protectMerchant, async (req, res) => {
  const { instruction = '', link = '' } = req.body || {};
  if (typeof instruction !== 'string' || instruction.length > 2000 || typeof link !== 'string' || link.length > 2048 || (link && !/^https:\/\//i.test(link))) {
    return res.status(400).json({ message: 'Invalid payment instructions or link' });
  }
  const order = await Order.findOneAndUpdate(
    { _id: req.params.orderId, merchantGroups: { $elemMatch: { merchant: req.merchant._id, status: { $nin: ['rejected', 'cancelled'] } } } },
    { $set: { 'merchantGroups.$.paymentInstruction': instruction.trim(), 'merchantGroups.$.paymentLink': link.trim() } },
    { new: true, runValidators: true },
  );
  if (!order) return res.status(404).json({ message: 'Order not found' });
  order.statusHistory.push({ status: 'payment_instructions_updated', actorType: 'merchant', actorId: req.merchant._id, changedAt: new Date() });
  await order.save();
  await notifyCustomer(order, 'Payment instructions updated', `Payment instructions are available for order ${order._id}.`);
  return res.json({ order, merchantGroup: order.merchantGroups.find((item) => String(item.merchant) === String(req.merchant._id)) });
});

router.patch('/:orderId/payment-received', protectMerchant, async (req, res) => {
  const order = await Order.findOne({ _id: req.params.orderId, merchantGroups: { $elemMatch: { merchant: req.merchant._id, paymentSentAt: { $exists: true }, paymentReceivedAt: { $exists: false } } } });
  if (!order) return res.status(409).json({ message: 'Payment Sent has not been recorded or payment is already confirmed' });
  const group = order.merchantGroups.find((item) => String(item.merchant) === String(req.merchant._id));
  group.paymentReceivedAt = new Date();
  group.paymentConfirmedAt = new Date();
  order.statusHistory.push({ status: 'payment_received', actorType: 'merchant', actorId: req.merchant._id, changedAt: group.paymentReceivedAt });
  await order.save();
  await notifyCustomer(order, 'Payment Received confirmed', `The Merchant confirmed receipt for order ${order._id}.`);
  return res.json({ order });
});

module.exports = router;
