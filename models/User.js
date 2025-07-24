const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  fullName: { type: String, required: true },

  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true,
  },

  password: { type: String, required: true },

  phone: { type: String, default: '' }, // ✅ NEW: Phone support

  role: {
    type: String,
    enum: ['user', 'admin'],
    default: 'user',
  },

  photo: { type: String, default: '' },

  // ✅ NEW: For 6-digit code-based reset
  resetCode: { type: String },             // 6-digit code
  resetCodeExpiry: { type: Date },         // Expires in 15 mins

}, { timestamps: true });

module.exports = mongoose.model('User', userSchema);
