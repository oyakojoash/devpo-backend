const mongoose = require('mongoose');
const dotenv = require('dotenv');
const Product = require('../models/Product'); // adjust if path is different

dotenv.config();

const products = [
  {
    name: 'Wireless Mouse 1',
    price: 19.99,
    image: 'img1.jpeg',
    vendorId: 'vendor1',
  },
  {
    name: 'Keyboard 1',
    price: 20.99,
    image: 'img2.jpeg',
    vendorId: 'vendor2',
  },
  {
    name: 'Monitor 1',
    price: 21.99,
    image: 'img3.jpeg',
    vendorId: 'vendor3',
  },
  {
    name: 'USB-C Hub 1',
    price: 22.99,
    image: 'img4.jpeg',
    vendorId: 'vendor1',
  },
  {
    name: 'Laptop Stand 1',
    price: 23.99,
    image: 'img5.jpeg',
    vendorId: 'vendor2',
  },
  {
    name: 'Webcam 1',
    price: 24.99,
    image: 'img6.jpeg',
    vendorId: 'vendor3',
  },
  {
    name: 'Desk Lamp 1',
    price: 25.99,
    image: 'img7.jpeg',
    vendorId: 'vendor1',
  },
  {
    name: 'Bluetooth Speaker 1',
    price: 26.99,
    image: 'img8.jpeg',
    vendorId: 'vendor2',
  },
  {
    name: 'Wireless Mouse 2',
    price: 27.99,
    image: 'img1.jpeg', // reused
    vendorId: 'vendor3',
  },
];

async function seedProducts() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ Connected to MongoDB');

    await Product.deleteMany();
    const inserted = await Product.insertMany(products);

    console.log(`✅ Inserted ${inserted.length} products`);
    process.exit(0);
  } catch (err) {
    console.error('❌ Error seeding products:', err.message);
    process.exit(1);
  }
}

seedProducts();
