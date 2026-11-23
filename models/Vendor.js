
const mongoose = require('mongoose');

const VendorSchema = new mongoose.Schema(
  {
    id: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    logo: {
      type: String,
      required: true,
    },
    description: {
      type: String,
      required: true,
      trim: true,
    },
    merchantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Merchant',
      sparse: true,
    },
    businessName: {
      type: String,
      trim: true,
    },
    contactEmail: {
      type: String,
      trim: true,
      lowercase: true,
    },
    contactPhone: {
      type: String,
      trim: true,
    },
    address: {
      type: String,
      trim: true,
    },
    settings: {
      store: {
        category: { type: String, trim: true, maxlength: 100, default: '' },
        productType: { type: String, trim: true, maxlength: 100, default: '' },
        location: { type: String, trim: true, maxlength: 200, default: '' },
        banner: { type: String, trim: true, maxlength: 2048, default: '' },
        visible: { type: Boolean, default: true },
        open: { type: Boolean, default: true },
      },
      delivery: {
        enabled: { type: Boolean, default: true }, areas: { type: [String], default: [] },
        charge: { type: Number, min: 0, default: 0 }, estimate: { type: String, maxlength: 100, default: '' },
        pickup: { type: Boolean, default: false }, processing: { type: String, maxlength: 100, default: '' },
        instructions: { type: String, maxlength: 2000, default: '' },
      },
      payments: {
        methods: { type: String, maxlength: 2000, default: '' },
        instructions: { type: String, maxlength: 2000, default: '' },
        receivingDetails: { type: String, maxlength: 2000, default: '' },
      },
      policies: {
        returns: { type: String, maxlength: 5000, default: '' },
        cancellations: { type: String, maxlength: 5000, default: '' },
        delivery: { type: String, maxlength: 5000, default: '' },
        terms: { type: String, maxlength: 10000, default: '' },
        supportEmail: { type: String, trim: true, lowercase: true, maxlength: 254, default: '' },
      },
    },
    approvalStatus: {
      type: String,
      enum: ['pending', 'approved', 'rejected'],
    },
    status: {
      type: String,
      enum: ['active', 'suspended'],
    },
  },
  { timestamps: true }
);

// Older seeded vendors predate approval/status fields, so keep that exact legacy
// shape visible while requiring explicit approval and activation for new records.
VendorSchema.statics.publicMarketplaceFilter = function () {
  return {
    $or: [
      { approvalStatus: 'approved', status: 'active' },
      { approvalStatus: { $exists: false }, status: { $exists: false } },
    ],
    'settings.store.visible': { $ne: false },
  };
};

module.exports = mongoose.model('Vendor', VendorSchema);
