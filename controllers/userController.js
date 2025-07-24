const User = require('../models/User');
const bcrypt = require('bcrypt');

// ✅ Get logged-in user
exports.getUser = async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('-password');
    if (!user) return res.status(404).json({ message: 'User not found' });
    res.status(200).json(user);
  } catch (err) {
    console.error('Get user failed:', err);
    res.status(500).json({ message: 'Failed to fetch user' });
  }
};

// ✅ Update user profile (fullName, email, phone, photo)
exports.updateProfile = async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: 'User not found' });

    user.fullName = req.body.fullName || user.fullName;
    user.email = req.body.email || user.email;
    user.phone = req.body.phone || user.phone;
    user.photo = req.body.photo || user.photo;

    await user.save();
    res.status(200).json({ message: '✅ Profile updated successfully' });
  } catch (err) {
    console.error('Update profile failed:', err);
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

    user.password = await bcrypt.hash(newPassword, 10);
    await user.save();

    res.status(200).json({ message: '✅ Password updated successfully' });
  } catch (err) {
    console.error('Password update failed:', err);
    res.status(500).json({ message: 'Password update failed' });
  }
};
