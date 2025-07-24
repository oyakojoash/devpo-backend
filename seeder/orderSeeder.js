const mongoose = require('mongoose');
const dotenv = require('dotenv');
const Order = require('../models/Order');

dotenv.config();

mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
.then(() => console.log('✅ MongoDB connected'))
.catch((err) => {
  console.error('❌ MongoDB connection error:', err.message);
  process.exit(1);
});

const userId = '6487c8f9fe1c6e0012a934a0'; // 🔁 Replace with real user _id
const fakeProductId = '64ad9ab20fe3b530cd2e8ccf'; // 🔁 Replace with a real product _id

const seedOrders = async () => {
  try {
    await Order.deleteMany();

    await Order.insertMany([
      {
        user: userId,
        products: [
          {
            productId: fakeProductId,
            name: 'Product 1',
            price: 100,
            quantity: 1,
          },
        ],
        totalPrice: 100,
        status: 'pending',
        shippingAddress: {
          street: '123 Test Street',
          city: 'Kampala',
          country: 'Uganda',
          postalCode: '00100',
        },
      },
      {
        user: userId,
        products: [
          {
            productId: fakeProductId,
            name: 'Product 2',
            price: 300,
            quantity: 2,
          },
        ],
        totalPrice: 600,
        status: 'processing',
        shippingAddress: {
          street: '456 Sample Avenue',
          city: 'Nairobi',
          country: 'Kenya',
          postalCode: '00200',
        },
      },
    ]);

    console.log('✅ Orders Seeded Successfully');
    process.exit(0);
  } catch (err) {
    console.error('❌ Seeding Failed:', err.message);
    process.exit(1);
  }
};

seedOrders();
