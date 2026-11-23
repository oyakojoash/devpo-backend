const mongoose = require('mongoose');

const normalizePhone = (value) => String(value || '').trim().replace(/[\s().-]/g, '');

const merchantSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Merchant name is required'],
    trim: true,
    minlength: 2,
    maxlength: 100,
  },
  email: {
    type: String,
    required: [true, 'Email is required'],
    lowercase: true,
    trim: true,
    maxlength: 254,
    match: [/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'A valid email is required'],
  },
  phone: {
    type: String,
    required: [true, 'Phone number is required'],
    set: normalizePhone,
    validate: {
      validator: (value) => /^\+?\d{7,15}$/.test(value),
      message: 'Enter a phone number with 7 to 15 digits, optionally prefixed by +',
    },
  },
  profileImage: {
    type: String,
    default: null,
    maxlength: 2048,
  },
  settings: {
    notifications: {
      orders: { type: Boolean, default: true },
      orderUpdates: { type: Boolean, default: true },
      messages: { type: Boolean, default: true },
      paymentReminders: { type: Boolean, default: true },
      lowStock: { type: Boolean, default: false },
      announcements: { type: Boolean, default: true },
    },
    privacy: {
      profileVisible: { type: Boolean, default: true },
      analytics: { type: Boolean, default: false },
    },
  },
  merchantId: {
    type: String,
    match: /^\d{5,}$/,
    immutable: true,
  },
  vendorApplicationReservation: {
    token: { type: String, select: false },
    expiresAt: { type: Date, select: false },
  },
  passwordHash: {
    type: String,
    required: [true, 'Password hash is required'],
    select: false,
    match: [/^\$argon2id\$/, 'Password must be stored as an Argon2id hash'],
  },
}, {
  timestamps: true,
  toJSON: { transform(_doc, ret) { delete ret.passwordHash; return ret; } },
  toObject: { transform(_doc, ret) { delete ret.passwordHash; return ret; } },
});

merchantSchema.index({ email: 1 }, { unique: true });
merchantSchema.index({ phone: 1 }, { unique: true });
merchantSchema.index(
  { merchantId: 1 },
  { unique: true, partialFilterExpression: { merchantId: { $type: 'string' } } },
);
merchantSchema.statics.normalizePhone = normalizePhone;

module.exports = mongoose.models.Merchant || mongoose.model('Merchant', merchantSchema);
