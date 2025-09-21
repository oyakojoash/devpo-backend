// controllers/orderController.js
const Order = require('../models/Order');

// ✅ Get all orders (Admin only)
exports.getAllOrders = async (req, res) => {
  try {
    const orders = await Order.find().populate("user", "name email");
    res.status(200).json(orders);
  } catch (err) {
    console.error("Admin order fetch failed:", err);
    res.status(500).json({ message: "Failed to fetch orders" });
  }
};

// ✅ Get current user's orders
exports.getUserOrders = async (req, res) => {
  try {
    const orders = await Order.find({ user: req.user._id })
      .sort({ createdAt: -1 })
      .populate('products.productId', 'name price image');
    
    res.status(200).json(orders);
  } catch (err) {
    console.error("User orders fetch failed:", err);
    res.status(500).json({ message: "Failed to fetch user orders" });
  }
};

// ✅ Get single order by ID (user can only access their own orders)
exports.getOrderById = async (req, res) => {
  try {
    const order = await Order.findOne({ 
      _id: req.params.id, 
      user: req.user._id 
    }).populate('products.productId', 'name price image');
    
    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }
    
    res.status(200).json(order);
  } catch (err) {
    console.error("Order fetch failed:", err);
    res.status(500).json({ message: "Failed to fetch order" });
  }
};

// ✅ Cancel order (user can only cancel their own orders)
exports.cancelOrder = async (req, res) => {
  try {
    const order = await Order.findOne({ 
      _id: req.params.id, 
      user: req.user._id 
    });
    
    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }
    
    if (order.status === 'cancelled') {
      return res.status(400).json({ message: "Order is already cancelled" });
    }
    
    if (order.status === 'delivered') {
      return res.status(400).json({ message: "Cannot cancel delivered order" });
    }
    
    order.status = 'cancelled';
    await order.save();
    
    res.status(200).json({ message: "Order cancelled successfully", order });
  } catch (err) {
    console.error("Order cancellation failed:", err);
    res.status(500).json({ message: "Failed to cancel order" });
  }
};
