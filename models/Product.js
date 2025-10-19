const mongoose = require('mongoose');

const productSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Product name is required'],
      trim: true,
    },
    price: {
      type: Number,
      required: [true, 'Product price is required'],
      min: [0, 'Price must be positive'],
    },
    image: {
      type: String, // stores uploaded filename
      required: [true, 'Product image is required'],
    },
    vendorId: {
      type: String, // could be ObjectId if you link to Vendor collection later
      required: [true, 'Vendor ID is required'],
    },
    description: {
      type: String,
      default: '',
      trim: true,
    },
  },
  { timestamps: true }
);

// Optional: add full image URL as a virtual field
productSchema.virtual('imageUrl').get(function () {
  const base = process.env.BACKEND_URL || '';
  return this.image ? `${base}/images/${this.image}` : null;
});

const Product = mongoose.model('Product', productSchema);

module.exports = Product;
