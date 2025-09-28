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

// ✅ Allowed origins (Frontend + local dev)
const allowedOrigins = [
  'https://dvepo.netlify.app',             // ✅ ACTUAL frontend URL (Netlify)
  'https://devpo-frontend.onrender.com',   // ✅ Backup Render URL
  'https://devpo1-frontend.onrender.com', // ✅ Keep old URL just in case
  'http://localhost:3000',                 // ✅ Local development
];

// ✅ CORS setup
app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin) return callback(null, true); // allow curl / mobile apps
      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      } else {
        return callback(new Error('❌ CORS not allowed'));
      }
    },
    credentials: true, // ✅ critical: allows cookies
  })
);

// ✅ Security & logging
app.use(helmet());
app.use(morgan('dev'));

// ✅ Core middleware
app.use(express.json());
app.use(cookieParser());

// ✅ Image serving API endpoint (instead of static middleware)
app.get('/images/:filename', (req, res) => {
  const filename = req.params.filename;
  const filepath = path.join(__dirname, 'public/images', filename);
  
  // Set proper headers for images
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Cache-Control', 'public, max-age=31536000');
  
  // Send the file
  res.sendFile(filepath, (err) => {
    if (err) {
      // Send fallback image if original not found
      const fallbackPath = path.join(__dirname, 'public/images/fallback.jpeg');
      res.sendFile(fallbackPath);
    }
  });
});

// ✅ Vendor logo API endpoint
app.get('/images/vendors/:filename', (req, res) => {
  const filename = req.params.filename;
  const filepath = path.join(__dirname, 'public/images/vendors', filename);
  
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'public, max-age=31536000');
  
  res.sendFile(filepath, (err) => {
    if (err) {
      const fallbackPath = path.join(__dirname, 'public/images/fallback-logo.png');
      res.sendFile(fallbackPath);
    }
  });
});

// ✅ Connect DB
const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI); // Mongoose v6+
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
const orderRoutes = require('./routes/my-orders'); // ✅ Added order routes for frontend

app.use('/api/products', productRoutes);    // ✅ Frontend expects /api/products
app.use('/api/cart', cartRoutes);        // ✅ Frontend expects /api/cart  
app.use('/api/auth', authRoutes);        // ✅ Frontend expects /api/auth
app.use('/api/user', userRoutes);        // ✅ Frontend expects /api/user
app.use('/api/orders', orderRoutes);     // ✅ Frontend expects /api/orders

// ✅ Root test route
app.get('/', (req, res) => {
  res.send('🚀 API is running on Render...');
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
