const mongoose = require('mongoose');

const storySchema = new mongoose.Schema({
  merchant: { type: mongoose.Schema.Types.ObjectId, ref: 'Merchant', required: true },
  mediaType: { type: String, enum: ['image', 'video'], required: true },
  mediaUrl: { type: String, required: true, maxlength: 2048 },
  cloudinaryPublicId: { type: String, required: true, maxlength: 255 },
  caption: { type: String, trim: true, maxlength: 500, default: '' },
  createdAt: { type: Date, required: true, default: Date.now },
  expiresAt: { type: Date, required: true },
  viewsCount: { type: Number, required: true, default: 0, min: 0 },
}, { versionKey: false });

// Expired records remain available to their owner; active queries filter expiresAt explicitly.
storySchema.index({ expiresAt: 1, createdAt: -1, _id: -1 }, { name: 'active_story_feed' });
storySchema.index({ merchant: 1, createdAt: -1, _id: -1 }, { name: 'merchant_story_history' });

module.exports = mongoose.models.Story || mongoose.model('Story', storySchema);
