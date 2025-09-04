const express = require('express');
const router = express.Router();
const { registerAdmin } = require('../controllers/admincontroller');
const { getAllOrders } = require('../controllers/orderController'); // ✅ Import
const { protectAdmin } = require('../middleware/protectAdmin');

// ✅ Admin routes
router.post('/register', registerAdmin);
router.get('/me', protectAdmin, (req, res) => res.json(req.admin));

// ✅ NEW: Fetch all orders
router.get('/orders', protectAdmin, getAllOrders); // ⬅️ Needed!

module.exports = router;

//"C:\Users\hp\Desktop\memo\proto1\backend\routes\adminOrderRoutes.js"