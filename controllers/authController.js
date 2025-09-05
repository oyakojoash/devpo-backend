const User = require('../models/User');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

exports.register = async (req, res) => {
  const { fullName, email, password, phone } = req.body;

  try {
    // Check if user already exists
    const existing = await User.findOne({ email });
    if (existing) {
      return res.status(409).json({ message: 'Email already registered' });
    }

    // Hash the password
    const hashed = await bcrypt.hash(password, 10);

    // Create new user
    const user = new User({ fullName, email, password: hashed, phone });
    await user.save();

    // Generate JWT
    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET || 'defaultsecret', {
      expiresIn: '7d',
    });

    // ✅ Always secure for Render (HTTPS)
    res.cookie('token', token, {
      httpOnly: true,
      secure: true,        // required for Render (HTTPS)
      sameSite: 'None',    // required for cross-origin
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    });

    res.status(201).json({
      message: '✅ Registration successful',
      user: {
        id: user._id,
        fullName: user.fullName,
        email: user.email,
      },
    });
  } catch (err) {
    console.error('[register] ❌', err.message);
    res.status(500).json({ message: 'Registration failed' });
  }
};
