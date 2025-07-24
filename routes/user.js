const express = require('express');
const verifyToken = require('../middleware/verifyToken');
const userCtrl = require('../controllers/userController');
const router = express.Router();

router.get('/me', verifyToken, userCtrl.getUser);
router.put('/me', verifyToken, userCtrl.updateProfile);
router.put('/password', verifyToken, userCtrl.updatePassword);

module.exports = router;
