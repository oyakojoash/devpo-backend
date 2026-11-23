const mongoose = require('mongoose');

const normalizePhone = (value) => String(value || '').trim().replace(/[\s().-]/g, '');

const affiliateSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, minlength: 2, maxlength: 100 },
  email: {
    type: String, required: true, lowercase: true, trim: true, maxlength: 254,
    match: [/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'A valid email is required'],
  },
  phone: {
    type: String, default: '', set: normalizePhone,
    validate: { validator: (value) => !value || /^\+?\d{7,15}$/.test(value), message: 'Enter a phone number with 7 to 15 digits, optionally prefixed by +' },
  },
  passwordHash: {
    type: String, required: true, select: false,
    match: [/^\$argon2id\$/, 'Password must be stored as an Argon2id hash'],
  },
  status: { type: String, enum: ['active', 'suspended'], default: 'active' },
  resetCode: { type: String, select: false },
  resetCodeExpiry: { type: Date, select: false },
}, {
  timestamps: true,
  toJSON: { transform(_doc, ret) { delete ret.passwordHash; delete ret.resetCode; delete ret.resetCodeExpiry; return ret; } },
  toObject: { transform(_doc, ret) { delete ret.passwordHash; delete ret.resetCode; delete ret.resetCodeExpiry; return ret; } },
});

affiliateSchema.index({ email: 1 }, { unique: true });
affiliateSchema.statics.normalizePhone = normalizePhone;

module.exports = mongoose.models.Affiliate || mongoose.model('Affiliate', affiliateSchema);
