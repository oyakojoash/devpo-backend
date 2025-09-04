const express = require('express');
const router = express.Router();
const { registerAdmin } = require('../controllers/admincontroller');
const { protectAdmin } = require('../middleware/protectAdmin');

// ✅ Admin register
router.post('/register', registerAdmin);

// ✅ Admin session check (used in Navbar, Layout)
router.get('/me', protectAdmin, (req, res) => {
  res.json(req.admin);
});

module.exports = router;
 

//"C:\Users\hp\Desktop\memo\proto1\backend\routes\adminUsers.js"