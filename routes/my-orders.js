const express = require('express');
const router = express.Router();
const verifyToken = require('../middleware/verifyToken');
const { getUserOrders } = require('../controllers/orderController');

router.get('/my-orders', verifyToken, getUserOrders);

module.exports = router;
