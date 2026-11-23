const mongoose = require('mongoose');

const merchantCounterSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  value: { type: Number, required: true, min: 0, validate: Number.isSafeInteger },
  initialized: { type: Boolean, required: true, default: false },
}, {
  versionKey: false,
  collection: 'merchantcounters',
});

merchantCounterSchema.statics.allocateNextMerchantId = async function allocateNextMerchantId() {
  const counter = await this.findOneAndUpdate(
    { _id: 'merchantId', initialized: true },
    { $inc: { value: 1 } },
    { new: true, projection: { value: 1 } },
  ).lean();

  if (!counter || !Number.isSafeInteger(counter.value) || counter.value < 1) return null;
  return String(counter.value).padStart(5, '0');
};

module.exports = mongoose.models.MerchantCounter || mongoose.model('MerchantCounter', merchantCounterSchema);
