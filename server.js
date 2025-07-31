const express = require('express');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const cookieParser = require('cookie-parser');
const cors = require('cors');

dotenv.config();
const app = express();
const PORT = process.env.PORT || 10000;

const allowedOrigins = [
  'https://devpo1-frontend.onrender.com', // ✅ your frontend
  'http://localhost:3000',                // ✅ local dev (optional)
];

app.use(cors({
  origin: allowedOrigins,
  credentials: true, // ✅ allow cookies
}));


app.use(express.json());
app.use(cookieParser());

// Connect DB
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

// Routes
const productRoutes = require('./routes/productRoutes');
const cartRoutes = require('./routes/cart');
const authRoutes = require('./routes/auth'); // handles login, register, /auth/me
const userRoutes = require('./routes/user'); // handles PUT /auth/me and /auth/password

app.use('/api/products', productRoutes);
app.use('/api/cart', cartRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/auth', userRoutes); // ✅ Mount extra user actions here

app.get('/', (req, res) => {
  res.send('API is running...');
});

app.use((req, res, next) => {
  res.status(404).json({ error: '❌ Route not found' });
});

app.use((err, req, res, next) => {
  console.error('❌ Server error:', err.message || err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
