const jwt = require('jsonwebtoken');
const User = require('../models/User');

// ✅ Middleware: Protect routes using JWT in cookies
const protect = async (req, res, next) => {
  const token = req.cookies?.token;
  console.log("🍪 Token from cookie:", token);

  if (!token) {
    return res.status(401).json({ message: '❌ Not authorized: no token' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    console.log("🔓 Decoded token:", decoded);

    const user = await User.findById(decoded.id).select('-password');
    console.log("✅ Loaded user from DB:", user);
    if (!user) {
      return res.status(401).json({ message: '❌ User not found' });
    }

    req.user = user; // Attach the user to request
    next();
  } catch (err) {
    console.error('[JWT Error] ❌', err.message);
    return res.status(401).json({ message: '❌ Invalid or expired token' });
  }
};

// ✅ Middleware: Restrict route to admins
const isAdmin = (req, res, next) => {
  if (req.user && (req.user.role === 'admin' || req.user.isAdmin === true)) {
    return next();
  }

  return res.status(403).json({ message: '❌ Admin access required' });
};

module.exports = {
  protect,
  isAdmin,
};
