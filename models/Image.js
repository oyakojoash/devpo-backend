const mongoose = require("mongoose");

const imageSchema = new mongoose.Schema({
  filename: { type: String, required: true }, // GridFS filename
  cloudinaryPublicId: { type: String },
  ownerType: { type: String, enum: ['admin', 'merchant'], default: 'admin' },
  ownerId: { type: mongoose.Schema.Types.ObjectId },
  caption: String,
  uploadedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model("Image", imageSchema);
