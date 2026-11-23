const mongoose = require('mongoose');

const affiliatePromotionSchema = new mongoose.Schema({
  affiliate: { type: mongoose.Schema.Types.ObjectId, ref: 'Affiliate', required: true, immutable: true },
  product: { type: mongoose.Schema.Types.ObjectId, ref: 'MerchantProduct', required: true, immutable: true },
  status: { type: String, enum: ['active', 'withdrawn'], default: 'active', required: true },
  joinedAt: { type: Date, default: Date.now, required: true, immutable: true },
  withdrawnAt: { type: Date, default: null },
}, { timestamps: true, strict: 'throw', autoIndex: false, autoCreate: false });

// This is a schema declaration only. Deploy the unique index through the
// project's reviewed index migration process; never use syncIndexes here.
affiliatePromotionSchema.index(
  { affiliate: 1, product: 1 },
  { unique: true, name: 'uniq_affiliate_product_promotion' },
);

module.exports = mongoose.models.AffiliatePromotion || mongoose.model('AffiliatePromotion', affiliatePromotionSchema);
