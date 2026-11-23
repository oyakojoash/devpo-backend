const mongoose = require('mongoose');

const PRODUCT_MODELS = ['retail', 'wholesale', 'subscription'];
const PRODUCT_STATUSES = ['draft', 'active', 'inactive', 'out of stock'];
const BILLING_INTERVALS = ['day', 'week', 'month', 'year'];

function isFinitePositive(value) {
  return Number.isFinite(value) && value > 0;
}

function isNonnegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isPositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function isImageReference(value) {
  if (typeof value !== 'string' || !value || value.length > 2048 || /[\u0000-\u0020\\]/.test(value)) return false;
  if (/^https?:\/\//i.test(value)) {
    try {
      const parsed = new URL(value);
      return ['http:', 'https:'].includes(parsed.protocol) && Boolean(parsed.hostname);
    } catch (_error) {
      return false;
    }
  }
  if (value.startsWith('/')) return !value.startsWith('//');
  return /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value);
}

const retailSchema = new mongoose.Schema({
  price: {
    type: Number,
    required: true,
    validate: [{ validator: Number.isFinite, message: 'Retail price must be finite' }, { validator: isFinitePositive, message: 'Retail price must be greater than zero' }],
  },
  stock: { type: Number, required: true, validate: { validator: isNonnegativeInteger, message: 'Retail stock must be a nonnegative integer' } },
}, { _id: false, strict: 'throw' });

const bulkPricingSchema = new mongoose.Schema({
  minimumQuantity: { type: Number, required: true, validate: { validator: isPositiveInteger, message: 'Bulk minimum quantity must be a positive integer' } },
  unitPrice: { type: Number, required: true, validate: [{ validator: Number.isFinite, message: 'Bulk unit price must be finite' }, { validator: isFinitePositive, message: 'Bulk unit price must be greater than zero' }] },
}, { _id: false, strict: 'throw' });

const wholesaleSchema = new mongoose.Schema({
  unitPrice: { type: Number, required: true, validate: [{ validator: Number.isFinite, message: 'Wholesale unit price must be finite' }, { validator: isFinitePositive, message: 'Wholesale unit price must be greater than zero' }] },
  minimumOrderQuantity: { type: Number, required: true, validate: { validator: isPositiveInteger, message: 'Minimum order quantity must be a positive integer' } },
  stock: { type: Number, required: true, validate: { validator: isNonnegativeInteger, message: 'Wholesale stock must be a nonnegative integer' } },
  unitsPerPackage: {
    type: Number,
    default: null,
    validate: { validator: (value) => value === null || isPositiveInteger(value), message: 'Units per package must be null or a positive integer' },
  },
  bulkPricing: { type: [bulkPricingSchema], default: [] },
}, { _id: false, strict: 'throw' });

const subscriptionSchema = new mongoose.Schema({
  price: { type: Number, required: true, validate: [{ validator: Number.isFinite, message: 'Subscription price must be finite' }, { validator: isFinitePositive, message: 'Subscription price must be greater than zero' }] },
  billingInterval: { type: String, required: true, enum: BILLING_INTERVALS },
  duration: { type: Number, required: true, validate: { validator: isPositiveInteger, message: 'Subscription duration must be a positive integer' } },
  autoRenew: { type: Boolean, required: true },
  benefits: { type: String, trim: true, maxlength: 2000 },
}, { _id: false, strict: 'throw' });

const merchantProductSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, minlength: 1, maxlength: 160 },
  description: { type: String, trim: true, default: '', maxlength: 5000 },
  productClass: { type: String, trim: true, default: '', maxlength: 80 },
  category: { type: String, trim: true, default: '', maxlength: 100 },
  sku: { type: String, trim: true, default: '', maxlength: 100 },
  model: { type: String, required: true, enum: PRODUCT_MODELS },
  status: { type: String, enum: PRODUCT_STATUSES, default: 'active' },
  affiliatePromotionEnabled: { type: Boolean, default: false },
  currency: { type: String, enum: ['KES'], default: 'KES' },
  images: {
    type: [{ type: String, trim: true, maxlength: 2048, validate: { validator: isImageReference, message: 'Image must be a valid URL or path reference' } }],
    default: [],
    validate: { validator: (images) => images.length <= 10, message: 'A product can have at most 10 image references' },
  },
  merchant: { type: mongoose.Schema.Types.ObjectId, ref: 'Merchant', required: true, immutable: true, index: true },
  retail: { type: retailSchema, default: undefined },
  wholesale: { type: wholesaleSchema, default: undefined },
  subscription: { type: subscriptionSchema, default: undefined },
  archivedAt: { type: Date, default: null },
}, {
  timestamps: true,
  strict: 'throw',
});

merchantProductSchema.pre('validate', function validateSelectedModel() {
  for (const model of PRODUCT_MODELS) {
    const hasModelData = this[model] !== undefined && this[model] !== null;
    if (this.model === model && !hasModelData) {
      this.invalidate(model, `${model} product details are required`);
    } else if (this.model !== model && hasModelData) {
      this.invalidate(model, `${model} details are not allowed for a ${this.model} product`);
    }
  }
  if (this.model === 'retail' && this.retail) {
    if (this.retail.stock === 0 && this.status === 'active') this.status = 'out of stock';
    else if (this.retail.stock > 0 && this.status === 'out of stock') this.status = 'active';
  }
});

merchantProductSchema.index({ merchant: 1, createdAt: -1 });
merchantProductSchema.index({ merchant: 1, model: 1, status: 1 });

merchantProductSchema.statics.PRODUCT_MODELS = PRODUCT_MODELS;
merchantProductSchema.statics.PRODUCT_STATUSES = PRODUCT_STATUSES;
merchantProductSchema.statics.BILLING_INTERVALS = BILLING_INTERVALS;
merchantProductSchema.statics.isImageReference = isImageReference;

module.exports = mongoose.models.MerchantProduct || mongoose.model('MerchantProduct', merchantProductSchema);
