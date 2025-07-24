const jwt = require('jsonwebtoken');

function verifyToken(req, res, next) {
  const token = req.cookies.userToken; // 👈 fixed

  if (!token) return res.status(401).json({ message: "Unauthorized" });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = { id: decoded.id }; // ✅ ready for use in controllers
    next();
  } catch (err) {
    res.status(403).json({ message: "Invalid token" });
  }
}

module.exports = verifyToken;
