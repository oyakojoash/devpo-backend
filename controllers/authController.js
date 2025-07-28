const User = require('../models/User');
const bcrypt = require('bcrypt');

exports.register = async (req, res) => {
  const { fullName, email, password, phone } = req.body;

  try {
    const existing = await User.findOne({ email });
    if (existing) {
      return res.status(409).json({ message: 'Email already registered' });
    }

    const hashed = await bcrypt.hash(password, 10);

    const user = new User({
      fullName,
      email,
      password: hashed,
      phone,
    });

    await user.save();

    res.status(201).json({ message: '✅ Registration successful' });
  } catch (err) {
    console.error('[register] ❌', err.message);
    res.status(500).json({ message: 'Registration failed' });
  }
};
