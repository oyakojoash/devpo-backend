const express = require('express');
const { protect } = require('../middleware/auth'); // Use improved middleware
const userCtrl = require('../controllers/userController');
const router = express.Router();

// GET /api/auth/me - Get logged-in user's info
router.get('/me', protect, userCtrl.getUser);     // now non-conflicting
router.put('/me', protect, userCtrl.updateProfile);
router.put('/password', protect, userCtrl.updatePassword);




module.exports = router;
