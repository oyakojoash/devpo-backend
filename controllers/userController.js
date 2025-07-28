const User = require('../models/User');
const bcrypt = require('bcrypt');

// ✅ Get logged-in user
exports.getUser = async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('-password');
    if (!user) return res.status(404).json({ message: 'User not found' });

    res.status(200).json(user);
  } catch (err) {
    console.error('[getUser] ❌', err.message);
    res.status(500).json({ message: 'Failed to fetch user' });
  }
};

// ✅ Update user profile (fullName, email, phone, photo)
exports.updateProfile = async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: 'User not found' });

    const { fullName, email, phone, photo } = req.body;

    if (email && email !== user.email) {
      const emailExists = await User.findOne({ email });
      if (emailExists) return res.status(409).json({ message: 'Email already in use' });
      user.email = email;
    }

    user.fullName = fullName || user.fullName;
    user.phone = phone || user.phone;
    user.photo = photo || user.photo;

    await user.save();
    res.status(200).json({ message: '✅ Profile updated successfully' });
  } catch (err) {
    console.error('[updateProfile] ❌', err.message);
    res.status(500).json({ message: 'Profile update failed' });
  }
};

// ✅ Change user password securely
exports.updatePassword = async (req, res) => {
  const { currentPassword, newPassword } = req.body;

  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: 'User not found' });

    const isMatch = await bcrypt.compare(currentPassword, user.password);
    if (!isMatch) return res.status(400).json({ message: 'Incorrect current password' });

    if (
      !/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[\W_]).{8,}$/.test(newPassword)
    ) {
      return res.status(400).json({
        message:
          'New password must include uppercase, lowercase, number, and symbol',
      });
    }

    user.password = await bcrypt.hash(newPassword, 10);
    await user.save();

    res.status(200).json({ message: '✅ Password updated successfully' });
  } catch (err) {
    console.error('[updatePassword] ❌', err.message);
    res.status(500).json({ message: 'Password update failed' });
  }
};
