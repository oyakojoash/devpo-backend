const express = require('express');
const { protect } = require('../middleware/auth');
const userCtrl = require('../controllers/userController');
const router = express.Router();

// ✅ User profile management (user data fetched via /api/auth/me)
router.put('/me', protect, userCtrl.updateProfile);      // PUT /api/user/me
router.put('/password', protect, userCtrl.updatePassword); // PUT /api/user/password

module.exports = router;
