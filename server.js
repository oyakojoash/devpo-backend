const express = require('express');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');

dotenv.config();
const app = express();
const PORT = process.env.PORT || 10000;

// -------------------- DEBUG ENV --------------------
console.log('🔍 Environment Debug:');
console.log('  - NODE_ENV:', process.env.NODE_ENV);
console.log('  - PORT:', PORT);
console.log('  - MONGO_URI:', process.env.MONGO_URI ? 'SET ✅' : 'MISSING ❌');
console.log('  - JWT_SECRET:', process.env.JWT_SECRET ? 'SET ✅' : 'MISSING ❌');
console.log('Cloudinary Config:', {
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});


// -------------------- MIDDLEWARE --------------------
const allowedOrigins = [
  "https://dvepo.netlify.app",
  "https://dvepoadmin.netlify.app",
  "https://devpo-frontend.onrender.com",
  "https://devpo1-frontend.onrender.com",
  "http://localhost:3000",
];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true); // allow Postman or curl
    if (allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error('❌ CORS not allowed'));
  },
  credentials: true,
}));



app.use(helmet());
app.use(morgan('dev'));
app.use(express.json());
app.use(cookieParser());

// -------------------- CONNECT MONGO + GRIDFSBUCKET --------------------
let gfsBucket;

const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ MongoDB connected');

    const db = mongoose.connection.db;
    gfsBucket = new mongoose.mongo.GridFSBucket(db, {
      bucketName: 'uploads',
    });
    app.locals.gfsBucket = gfsBucket;
    console.log('✅ GridFSBucket initialized');
  } catch (error) {
    console.error('❌ MongoDB connection failed:', error.message);
    process.exit(1);
  }
};

connectDB();

// -------------------- ROUTES --------------------
const productRoutes = require('./routes/products');
const cartRoutes = require('./routes/cart');
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/user');
const orderRoutes = require('./routes/order');
const vendorsRoutes = require('./routes/vendors');
const imageRoutes = require('./routes/imageRoutes'); 
const admin = require('./routes/admin');

// -------------------- IMAGE ROUTE WITH PROPER CORS --------------------

app.use('/api/images', (req, res, next) => {
  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
  next();
});
app.use('/api/images', imageRoutes);

// -------------------- API ROUTES --------------------
app.use('/api/products', productRoutes);
app.use('/api/cart', cartRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/user', userRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/vendors', vendorsRoutes);
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
