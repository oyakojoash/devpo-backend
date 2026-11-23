const Order = require('../models/Order');
const mongoose = require('mongoose');
const MerchantProduct = require('../models/MerchantProduct');
const { notifyMerchants, notifyVendors } = require('../services/orderNotifications');

exports.getUserOrders = async (req, res) => {
  try {
    const orders = await Order.find({ user: req.user._id })
      .sort({ createdAt: -1 }).limit(100)
      .populate('products.productId', 'name price image').lean();
    return res.status(200).json(orders);
  } catch (error) {
    console.error('User order fetch failed:', error.message);
    return res.status(500).json({ message: 'Failed to fetch orders' });
  }
};

exports.getOrderById = async (req, res) => {
  try {
    const order = await Order.findOne({ _id: req.params.id, user: req.user._id })
      .populate('products.productId', 'name price image').lean();
    if (!order) return res.status(404).json({ message: 'Order not found' });
    return res.status(200).json(order);
  } catch (error) {
    return res.status(400).json({ message: 'Invalid order ID' });
  }
};

exports.cancelOrder = async (req, res) => {
  let session;
  let order;
  try {
    const snapshot = await Order.findOne({ _id: req.params.id, user: req.user._id, status: { $in: ['pending', 'processing'] } }).lean();
    if (!snapshot) return res.status(404).json({ message: 'Order not found or can no longer be cancelled' });
    if (!snapshot.merchantGroups?.length) {
      order = await Order.findOneAndUpdate(
        { _id: req.params.id, user: req.user._id, status: { $in: ['pending', 'processing'] } },
        { $set: { status: 'cancelled' }, $push: { statusHistory: { status: 'cancelled', actorType: 'customer', actorId: req.user._id } } },
        { new: true, runValidators: true },
      );
      if (!order) return res.status(404).json({ message: 'Order not found or can no longer be cancelled' });
      if (order.vendorGroups?.length) await notifyVendors(order, 'Order cancelled', `Customer cancelled order ${order._id}.`);
      return res.status(200).json({ message: 'Order cancelled successfully', order });
    }
    session = await mongoose.startSession();
    await session.withTransaction(async () => {
      const current = await Order.findOne({ _id: req.params.id, user: req.user._id, status: { $in: ['pending', 'processing'] } }).session(session);
      if (!current || current.merchantGroups.some((group) => !['pending', 'rejected', 'cancelled'].includes(group.status))) return;
      for (const group of current.merchantGroups) {
        if (group.status !== 'pending') continue;
        group.status = 'cancelled';
        for (const index of group.productIndexes) {
          const line = current.products[index];
          if (line?.sourceType !== 'merchantProduct' || line.stockRestored) continue;
          line.stockRestored = true;
          await MerchantProduct.updateOne(
            { _id: line.productId, merchant: group.merchant },
            [{ $set: { 'retail.stock': { $add: ['$retail.stock', line.quantity] }, status: { $cond: [{ $eq: ['$status', 'out of stock'] }, 'active', '$status'] } } }],
            { session },
          );
        }
      }
      current.status = 'cancelled';
      current.statusHistory.push({ status: 'cancelled', actorType: 'customer', actorId: req.user._id, changedAt: new Date() });
      current.markModified('products');
      current.markModified('merchantGroups');
      await current.save({ session });
      order = current;
    });
    if (!order) return res.status(404).json({ message: 'Order not found or can no longer be cancelled' });
    await notifyMerchants(order, 'Order cancelled', `Customer cancelled the pending Merchant items in order ${order._id}.`);
    return res.status(200).json({ message: 'Order cancelled successfully', order });
  } catch (error) {
    if (error?.name === 'CastError' || error?.name === 'BSONError') {
      return res.status(400).json({ message: 'Invalid order ID' });
    }
    console.error('Order cancellation failed:', error?.message || error);
    return res.status(500).json({ message: 'Failed to cancel order' });
  } finally { if (session) await session.endSession(); }
};
