const mongoose = require('mongoose');

const cartItemSchema = new mongoose.Schema({
  sourceType: { type: String, enum: ['product', 'merchantProduct'], default: 'product', required: true },
  // References are resolved explicitly by sourceType in routes/cart.js.
  productId: { type: mongoose.Schema.Types.ObjectId, required: true },
  quantity: { type: Number, required: true, default: 1 },
});

const cartSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  items: [cartItemSchema],
  // Kept with the cart so applying checkout cleanup and recording that it ran
  // happen in the same atomic document update.
  processedOrderIds: {
    type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Order' }],
    default: [],
    select: false,
  },
});

module.exports = mongoose.models.Cart || mongoose.model('Cart', cartSchema);
