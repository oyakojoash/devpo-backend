const jwt = require("jsonwebtoken");
const Admin = require("../models/adminmodels");

const protectAdmin = async (req, res, next) => {
  const token = req.cookies.adminToken;

  if (!token) {
    return res.status(401).json({ message: "Admin not authenticated" });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    if (decoded.role !== 'admin') {
      return res.status(403).json({ message: "Invalid admin role" });
    }

    const admin = await Admin.findById(decoded.id).select("-password");
    if (!admin) {
      return res.status(403).json({ message: "Admin not found" });
    }

    req.admin = admin;
    next();
  } catch (err) {
    return res.status(403).json({ message: "Invalid or expired token" });
  }
};

module.exports = { protectAdmin };


//"C:\Users\hp\Desktop\memo\proto1\backend\middleware\protectAdmin.js"