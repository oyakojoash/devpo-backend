const express = require('express');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');

dotenv.config();
const app = express();
const PORT = process.env.PORT || 10000;

// 🔍 DEBUG: Check environment variables on startup
console.log('🔍 Environment Debug:');
console.log('  - NODE_ENV:', process.env.NODE_ENV);
console.log('  - PORT:', process.env.PORT);
console.log('  - MONGO_URI:', process.env.MONGO_URI ? 'SET ✅' : 'MISSING ❌');
console.log('  - JWT_SECRET:', process.env.JWT_SECRET ? 'SET ✅' : 'MISSING ❌');
if (!process.env.JWT_SECRET) {
  console.error('🚨 CRITICAL: JWT_SECRET is missing! Authentication will fail!');
}

// ✅ Allowed origins
const allowedOrigins = [
  'https://dvepo.netlify.app',
  'https://devpo-frontend.onrender.com',
  'https://devpo1-frontend.onrender.com',
  'http://localhost:3000',
];

// ✅ CORS options


// ✅ Apply CORS globally for APIs
app.use(cors(corsOptions));

// ✅ Security & logging
app.use(helmet());
app.use(morgan('dev'));

// ✅ Core middleware
app.use(express.json());
app.use(cookieParser());
const corsOptions = {
  origin: function(origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    callback(new Error('CORS not allowed'));
  },
  credentials: true,
};

// Product images
app.use('/images', (req, res, next) => {
  res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.header('Access-Control-Allow-Credentials', 'true');
  next();
}, express.static(path.join(__dirname, 'public/images')));

// Vendor images
app.use('/images/vendors', (req, res, next) => {
  res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.header('Access-Control-Allow-Credentials', 'true');
  next();
}, express.static(path.join(__dirname, 'public/images/vendors')));




// ✅ Connect DB
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

// ✅ Routes
const productRoutes = require('./routes/productRoutes');
const cartRoutes = require('./routes/cart');
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/user');
const orderRoutes = require('./routes/my-orders');

app.use('/api/products', productRoutes);
app.use('/api/cart', cartRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/user', userRoutes);
app.use('/api/orders', orderRoutes);

// ✅ Root test route
app.get('/', (req, res) => {
  res.send('🚀 API is running');
});

// ✅ 404 handler
app.use((req, res, next) => {
  res.status(404).json({ error: '❌ Route not found' });
});

// ✅ Error handler
app.use((err, req, res, next) => {
  console.error('❌ Server error:', err.stack || err.message || err);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

// ✅ Graceful shutdown
process.on('SIGINT', async () => {
  await mongoose.connection.close();
  console.log('🛑 MongoDB connection closed');
  process.exit(0);
});

// ✅ Start server
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
