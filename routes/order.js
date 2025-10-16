const express = require('express');
const Order = require('../models/Order');
const { protect, isAdmin } = require('../middleware/auth');

const router = express.Router();
const { getUserOrders, getOrderById, cancelOrder } = require('../controllers/orderController');

/* --------------------------------------------------
   POST /api/orders - Place a new order
--------------------------------------------------- */
router.post('/', protect, async (req, res) => {
  try {
    const { products, totalPrice, name, email, phone } = req.body;

    if (!products || products.length === 0) {
      return res.status(400).json({ message: 'No products in order' });
    }

    const order = new Order({
      user: req.user._id, // still keep reference if you want
      userInfo: {         // store snapshot of entered info
        name: name || req.user.name,
        email: email || req.user.email,
        phone: phone || req.user.phone,
      },
      products,
      totalPrice,
      status: 'pending',
    });

    await order.save();
    res.status(201).json(order);
  } catch (err) {
    console.error('❌ Error placing order:', err.message);
    res.status(500).json({ message: 'Failed to place order' });
  }
});


/* --------------------------------------------------
   GET /api/orders/my-orders - Current user's orders
--------------------------------------------------- */
router.get('/my-orders', protect, getUserOrders);

/* --------------------------------------------------
   GET /api/orders/:id - Single order by ID
--------------------------------------------------- */
router.get('/:id', protect, getOrderById);

/* --------------------------------------------------
   PATCH /api/orders/:id/cancel - Cancel order
--------------------------------------------------- */
router.patch('/:id/cancel', protect, cancelOrder);

/* --------------------------------------------------
   GET /api/admin/orders - Get all orders (Admin)
--------------------------------------------------- */
router.get('/orders', protect, isAdmin, async (req, res) => {
  try {
    const orders = await Order.find({})
      .sort({ createdAt: -1 })
      .populate('user', 'name email phone') // ✅ populate user info
      .populate('products.productId', 'name price image'); // optional: populate product info

    res.json(orders);
  } catch (err) {
    console.error('❌ Admin fetch orders error:', err.message);
    res.status(500).json({ message: 'Failed to fetch admin orders' });
  }
});

/* --------------------------------------------------
   GET /api/admin/orders/:id - Single order (Admin)
--------------------------------------------------- */
router.get('/orders/:id', protect, isAdmin, async (req, res) => {
  try {
    const order = await Order.findById(req.params.id)
      .populate('user', 'name email phone') // ✅ populate user info
      .populate('products.productId', 'name price image'); // optional: populate product info

    if (!order) return res.status(404).json({ message: 'Order not found' });

    res.json(order);
  } catch (err) {
    console.error('❌ Admin view order error:', err.message);
    res.status(500).json({ message: 'Failed to fetch order' });
  }
});

/* --------------------------------------------------
   PATCH /api/admin/orders/:id/status - Update order status
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
