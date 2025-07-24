const express = require('express');
const Order = require('../models/Order');
const { protect, isAdmin } = require('../middleware/auth');

const router = express.Router();

/* --------------------------------------------------
   GET /api/admin/orders - Get all orders (Admin only)
--------------------------------------------------- */
router.get('/orders', protect, isAdmin, async (req, res) => {
  try {
    const orders = await Order.find({})
      .sort({ createdAt: -1 })
      .populate('user', 'name email');

    res.json(orders);
  } catch (err) {
    console.error('❌ Admin fetch orders error:', err.message);
    res.status(500).json({ message: 'Failed to fetch admin orders' });
  }
});

/* --------------------------------------------------
   GET /api/admin/orders/:id - View single order (Admin only)
--------------------------------------------------- */
router.get('/orders/:id', protect, isAdmin, async (req, res) => {
  try {
    const order = await Order.findById(req.params.id)
      .populate('user', 'name email')
      .populate('products.productId');

    if (!order) {
      return res.status(404).json({ message: 'Order not found' });
    }

    res.json(order);
  } catch (err) {
    console.error('❌ Admin view order error:', err.message);
    res.status(500).json({ message: 'Failed to fetch order' });
  }
});

/* --------------------------------------------------
   PATCH /api/admin/orders/:id/status - Update order status (Admin only)
--------------------------------------------------- */
router.patch('/orders/:id/status', protect, isAdmin, async (req, res) => {
  try {
    const { status } = req.body;
    const validStatuses = ['pending', 'processing', 'shipped', 'delivered', 'cancelled'];

    if (!validStatuses.includes(status)) {
      return res.status(400).json({ message: 'Invalid status' });
    }

    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ message: 'Order not found' });

    order.status = status;
    await order.save();

    res.json({ message: 'Order status updated', order });
  } catch (err) {
    console.error('❌ Admin update order status error:', err.message);
    res.status(500).json({ message: 'Failed to update order status' });
  }
});

module.exports = router;
