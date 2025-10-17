// server.js
const express = require('express');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');
const Grid = require('gridfs-stream');
const fs = require('fs');

dotenv.config();
const app = express();
const PORT = process.env.PORT || 10000;

// -------------------- DEBUG ENV --------------------
console.log('🔍 Environment Debug:');
console.log('  - NODE_ENV:', process.env.NODE_ENV);
console.log('  - PORT:', PORT);
console.log('  - MONGO_URI:', process.env.MONGO_URI ? 'SET ✅' : 'MISSING ❌');
console.log('  - JWT_SECRET:', process.env.JWT_SECRET ? 'SET ✅' : 'MISSING ❌');
if (!process.env.JWT_SECRET) console.error('🚨 JWT_SECRET missing!');

// -------------------- MIDDLEWARE --------------------
const allowedOrigins = [
  'https://dvepo.netlify.app',
  'https://devpo-frontend.onrender.com',
  'https://devpo1-frontend.onrender.com',
  'http://localhost:3000',
];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error('❌ CORS not allowed'));
  },
  credentials: true,
}));

app.use(helmet());
app.use(morgan('dev'));
app.use(express.json());
app.use(cookieParser());

// -------------------- CONNECT MONGO --------------------
const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ MongoDB connected');

    const conn = mongoose.connection;
    conn.once('open', () => {
      const gfs = Grid(conn.db, mongoose.mongo);
      gfs.collection('uploads');
      app.locals.gfs = gfs;
      console.log('✅ MongoDB + GridFS initialized');
    });
  } catch (error) {
    console.error('❌ MongoDB connection failed:', error.message);
    process.exit(1);
  }
};
connectDB();

// -------------------- ROUTES --------------------
// Require routes first
const productRoutes = require('./routes/productRoutes');
const cartRoutes = require('./routes/cart');
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/user');
const orderRoutes = require('./routes/order');
const vendorsRoutes = require('./routes/vendors');
const imageRoutes = require('./routes/imageRoutes'); 
const adminUsers = require('./routes/adminUsers');
const adminAuthRoutes = require('./routes/adminAuthRoutes');
const admin = require('./routes/admin');


// Image route for GridFS + fallback

// -------------------- IMAGE SERVE --------------------
// Global CORS headers for images
app.use('/images', (req, res, next) => {
  res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.header('Access-Control-Allow-Credentials', 'true');
  next();
});

// Serve images through router
// -------------------- IMAGE SERVE --------------------
// Global CORS & COEP/CORP headers for images
app.use('/api/images/', (req, res, next) => {
  res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.header('Access-Control-Allow-Credentials', 'true');
  res.header('Cross-Origin-Resource-Policy', 'cross-origin'); // ✅ allow cross-origin usage
  next();
});

// Serve images through router (GridFS + fallback)
app.use('/api/images/', imageRoutes); // mounted once
 // mounted once

// -------------------- API ROUTES --------------------
app.use('/api/products', productRoutes);
app.use('/api/cart', cartRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/user', userRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/vendors',vendorsRoutes );
app.use('/api/admin', adminAuthRoutes);
app.use('/api/admin', adminUsers);
app.use('/api/admin', admin);

// -------------------- ROOT & ERROR --------------------
app.get('/', (req, res) => res.send('🚀 API is running'));
app.use((req, res) => res.status(404).json({ error: '❌ Route not found' }));
app.use((err, req, res, next) => {
  console.error('❌ Server error:', err.stack || err.message || err);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

// -------------------- GRACEFUL SHUTDOWN --------------------
process.on('SIGINT', async () => {
  await mongoose.connection.close();
  console.log('🛑 MongoDB connection closed');
  process.exit(0);
});

// -------------------- START SERVER --------------------
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
