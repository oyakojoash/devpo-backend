
const mongoose = require('mongoose');

const orderSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },

  userInfo: {
    name: { type: String, required: false },
    email: { type: String },
    phone: { type: String },
  },

  products: [
    {
      productId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Product',
        required: true,
      },
      name: { type: String, required: true },
      price: { type: Number, required: true },
      quantity: { type: Number, required: true },
      sourceType: {
        type: String,
        enum: ['product', 'merchantProduct'],
        default: 'product',
      },
      ownerType: {
        type: String,
        enum: ['vendor', 'merchant'],
        default: 'vendor',
      },
      ownerId: mongoose.Schema.Types.ObjectId,
      ownerStoreId: String,
      image: String,
      currency: { type: String, default: 'KES' },
      stockRestored: { type: Boolean, default: false },
    },
  ],

  totalPrice: {
    type: Number,
    required: true,
  },

  status: {
    type: String,
    enum: [
      'pending',
      'accepted',
      'processing',
      'shipped',
      'dispatched',
      'delivered',
      'cancelled',
      'rejected',
    ],
    default: 'pending',
  },

  merchantGroups: [{
    merchant: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Merchant',
      required: true,
    },
    productIndexes: [Number],
    status: {
      type: String,
      enum: [
        'pending',
        'accepted',
        'rejected',
        'processing',
        'dispatched',
        'delivered',
        'cancelled',
      ],
      default: 'pending',
    },
    rejectionReason: String,
    paymentInstruction: { type: String, maxlength: 2000 },
    paymentLink: { type: String, maxlength: 2048 },
    paymentSentAt: Date,
    paymentReceivedAt: Date,
    paymentConfirmedAt: Date,
  }],

  statusHistory: [{
    status: String,
    actorType: {
      type: String,
      enum: ['admin', 'merchant', 'customer', 'system'],
    },
    actorId: mongoose.Schema.Types.ObjectId,
    changedAt: { type: Date, default: Date.now },
  }],

  vendorGroups: [{
    vendor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Vendor',
    },
    vendorId: String,
    productIndexes: [Number],
  }],

  idempotencyKey: { type: String, select: false },
  idempotencyFingerprint: { type: String, select: false },

  shippingAddress: {
    recipient: { type: String },
    phone: { type: String },
    county: { type: String },
    town: { type: String },
    area: { type: String },
    building: { type: String },
    instructions: { type: String },
  },
}, {
  timestamps: true,
  autoIndex: false,
  autoCreate: false,
});

orderSchema.index({ user: 1, createdAt: -1 });

orderSchema.index(
  { user: 1, idempotencyKey: 1 },
  {
    unique: true,
    partialFilterExpression: {
      idempotencyKey: { $type: 'string' },
    },
  }
);

module.exports =
  mongoose.models.Order || mongoose.model('Order', orderSchema);
