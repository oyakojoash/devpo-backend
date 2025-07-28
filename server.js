const express = require('express');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const cookieParser = require('cookie-parser'); // Needed for auth middleware
const app = express();

dotenv.config();
const PORT = process.env.PORT || 10000;

// Middleware
app.use(express.json());
app.use(cookieParser()); // To read cookies for auth

// MongoDB Connection
const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ MongoDB connected');
  } catch (error) {
    console.error('❌ MongoDB connection failed:', error.message);
    process.exit(1);
  }
};

connectDB();

// ✅ Route imports
const productRoutes = require('./routes/productRoutes');
const cartRoutes = require('./routes/cart');
// Add more as needed: const userRoutes = require('./routes/userRoutes');

// ✅ Use routes
app.use('/api/products', productRoutes);
app.use('/api/cart', cartRoutes);
// app.use('/api/users', userRoutes); // Uncomment when ready

// Default route
app.get('/', (req, res) => {
  res.send('API is running');
});

// Start server
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
