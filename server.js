const express = require('express');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const cookieParser = require('cookie-parser');
const cors = require('cors');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;

// ✅ CORS middleware supporting both dev and prod
const allowedOrigins = [
  'http://localhost:3000',
  'https://devpo-frontend.onrender.com'
];

app.use(cors({
  origin: function (origin, callback) {
    // allow requests with no origin like mobile apps or curl
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    } else {
      return callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
}));

// ✅ Middleware
app.use(express.json());
app.use(cookieParser());

// ✅ MongoDB Connection
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
// const userRoutes = require('./routes/userRoutes'); // Uncomment when ready

// ✅ Routes
app.use('/api/products', productRoutes);
app.use('/api/cart', cartRoutes);
// app.use('/api/users', userRoutes); // Uncomment when implemented

// ✅ Default route
app.get('/', (req, res) => {
  res.send('API is running...');
});

// ✅ 404 Fallback
app.use((req, res, next) => {
  res.status(404).json({ error: 'Route not found' });
});

// ✅ Global error handler
app.use((err, req, res, next) => {
  console.error('❌ Server Error:', err.message || err);
  res.status(500).json({ error: 'Server error' });
});

// ✅ Start server
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
