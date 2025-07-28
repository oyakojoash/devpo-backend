const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  fullName: {
    type: String,
    required: [true, 'Full name is required'],
    trim: true,
  },

  email: {
    type: String,
    required: [true, 'Email is required'],
    unique: true,
    lowercase: true,
    trim: true,
  },

  password: {
    type: String,
    required: [true, 'Password is required'],
    minlength: 8,
  },

  phone: {
    type: String,
    default: '',
    trim: true,
  },

  role: {
    type: String,
    enum: ['user', 'admin'],
    default: 'user',
  },

  photo: {
    type: String,
    default: '',
  },

  resetCode: {
    type: String, // For 6-digit code
  },

  resetCodeExpiry: {
    type: Date, // Expires in 15 minutes
  },
}, {
  timestamps: true,
});
