const jwt = require('jsonwebtoken');

function verifyToken(req, res, next) {
  const token = req.cookies.token; // ✅ fixed cookie name

  if (!token) {
    return res.status(401).json({ message: "Unauthorized - No token provided" });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'fallback_secret'); // optional fallback
    req.user = { id: decoded.id };
    next();
  } catch (err) {
    console.error("JWT verification error:", err);
    res.status(401).json({ message: "Invalid or expired token" });
  }
}

module.exports = verifyToken;
