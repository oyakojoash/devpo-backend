// controllers/orderController.js
const Order = require('../models/Order');

// ✅ For admin dashboard
exports.getAllOrders = async (req, res) => {
  try {
    const orders = await Order.find().populate("user", "name email");
    res.status(200).json(orders);
  } catch (err) {
    console.error("Admin order fetch failed:", err);
    res.status(500).json({ message: "Failed to fetch orders" });
  }
};
