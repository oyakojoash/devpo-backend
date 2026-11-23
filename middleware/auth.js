const jwt = require('jsonwebtoken');
const User = require('../models/User');

const protect = async (req, res, next) => {
  const token = req.cookies?.token;
  if (!token) return res.status(401).json({ message: 'Not authorized' });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    const user = await User.findById(decoded.id).select('-password -resetCode -resetCodeExpiry').lean();
    if (!user) return res.status(401).json({ message: 'Not authorized' });
    req.user = user;
    return next();
  } catch (_error) {
    return res.status(401).json({ message: 'Not authorized' });
  }
};

const isAdmin = (req, res, next) => {
  if (req.user?.role === 'admin' || req.user?.isAdmin === true) return next();
  return res.status(403).json({ message: 'Admin access required' });
};

module.exports = { protect, isAdmin };