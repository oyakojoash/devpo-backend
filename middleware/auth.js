const jwt = require('jsonwebtoken');
const User = require('../models/User');

// ✅ Protect routes (user must be logged in via cookie)
const protect = async (req, res, next) => {
  const token = req.cookies.token;

  if (!token) {
    return res.status(401).json({ message: 'Not authorized, no token' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id).select('-password');

    if (!user) {
      return res.status(401).json({ message: 'User not found' });
    }

    req.user = user; // Attach the user to request
    next();
  } catch (err) {
    console.error('JWT error:', err.message);
    return res.status(401).json({ message: 'Invalid or expired token' });
  }
};

// ✅ Restrict access to admins only
const isAdmin = (req, res, next) => {
  if (req.user && (req.user.role === 'admin' || req.user.isAdmin)) {
    return next();
  }

  return res.status(403).json({ message: 'Admin access required' });
};

module.exports = {
  protect,
  isAdmin,
};
