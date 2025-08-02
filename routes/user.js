const express = require('express');
const { protect } = require('../middleware/auth'); // Use improved middleware
const userCtrl = require('../controllers/userController');
const router = express.Router();

// GET /api/auth/me - Get logged-in user's info
router.get('/me', protect, userCtrl.getUser);

// PUT /api/auth/me - Update user's profile info
router.put('/me', protect, userCtrl.updateProfile);

// PUT /api/auth/password - Update user's password
router.put('/password', protect, userCtrl.updatePassword);

module.exports = router;
