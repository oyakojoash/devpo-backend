const mongoose = require('mongoose');
const dotenv = require('dotenv');
const Product = require('../models/Product');

dotenv.config();

// Full image URLs using BACKEND_URL from .env
const updatedImages = [
  { name: 'Wireless Mouse 1', image: 'img1.jpeg' },
  { name: 'Keyboard 1', image: 'img2.jpeg' },
  { name: 'Monitor 1', image: 'img3.jpeg' },
  { name: 'USB-C Hub 1', image: 'img4.jpeg' },
  { name: 'Laptop Stand 1', image: 'img5.jpeg' },
  { name: 'Webcam 1', image: 'img6.jpeg' },
  { name: 'Desk Lamp 1', image: 'img7.jpeg' },
  { name: 'Bluetooth Speaker 1', image: 'img8.jpeg' },
  { name: 'Wireless Mouse 2', image: 'img1.jpeg' }, // reused
];

async function updateProductImages() {
  try {
    console.log("🌍 Connecting to MongoDB...");
    await mongoose.connect(process.env.MONGO_URI);
    console.log("✅ Connected to MongoDB Atlas");

    const BACKEND_URL = process.env.BACKEND_URL || '';

    for (const item of updatedImages) {
      const fullUrl = `${BACKEND_URL}/public/images/${item.image}`;
      const result = await Product.updateOne(
        { name: item.name },
        { $set: { image: fullUrl } }
      );
      console.log(`🖼 Updated "${item.name}" - matched: ${result.matchedCount}`);
    }

    console.log('🎉 All image URLs updated successfully!');
    process.exit(0);
  } catch (err) {
    console.error('❌ Error updating product images:', err);
    process.exit(1);
  }
}

updateProductImages();
