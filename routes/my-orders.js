const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const { 
  getUserOrders, 
  getOrderById, 
  cancelOrder 
} = require('../controllers/orderController');

// ✅ GET /api/orders/my-orders - Get current user's orders
router.get('/my-orders', protect, getUserOrders);

// ✅ GET /api/orders/:id - Get single order by ID
router.get('/:id', protect, getOrderById);

// ✅ PATCH /api/orders/:id/cancel - Cancel an order
router.patch('/:id/cancel', protect, cancelOrder);

module.exports = router;
