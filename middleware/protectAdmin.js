const jwt = require('jsonwebtoken');
const Admin = require('../models/adminmodels');

const protectAdmin = async (req, res, next) => {
  const token = req.cookies?.adminToken;
  if (!token) return res.status(401).json({ message: 'Admin not authenticated' });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    if (decoded.role !== 'admin') return res.status(403).json({ message: 'Admin access required' });
    const admin = await Admin.findById(decoded.id).select('-password').lean();
    if (!admin || admin.role !== 'admin') return res.status(403).json({ message: 'Admin access required' });
    req.admin = admin;
    return next();
  } catch (_error) {
    return res.status(401).json({ message: 'Admin not authenticated' });
  }
};

module.exports = { protectAdmin };