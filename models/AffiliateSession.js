const mongoose = require('mongoose');

const MAX_SESSION_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const affiliateSessionSchema = new mongoose.Schema({
  affiliate: { type: mongoose.Schema.Types.ObjectId, ref: 'Affiliate', required: true, index: true },
  tokenHash: { type: String, required: true, select: false, match: [/^[a-f0-9]{64}$/, 'Session token hash must be a SHA-256 digest'] },
  expiresAt: {
    type: Date, required: true,
    validate: {
      validator(value) {
        const start = this.createdAt ? this.createdAt.getTime() : Date.now();
        return value instanceof Date && value.getTime() > start && value.getTime() <= start + MAX_SESSION_AGE_MS;
      },
      message: 'An affiliate session cannot last longer than seven days',
    },
  },
  revokedAt: { type: Date, default: null },
}, { timestamps: true });

affiliateSessionSchema.index({ tokenHash: 1 }, { unique: true });
affiliateSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
affiliateSessionSchema.index({ affiliate: 1, expiresAt: 1 });
affiliateSessionSchema.statics.MAX_SESSION_AGE_MS = MAX_SESSION_AGE_MS;

module.exports = mongoose.models.AffiliateSession || mongoose.model('AffiliateSession', affiliateSessionSchema);
