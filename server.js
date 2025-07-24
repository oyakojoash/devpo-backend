const express = require('express');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const path = require('path');
const connectDB = require('./config/db');

dotenv.config();

const app = express();
connectDB();

// ✅ Middleware
app.use(cors({
  origin: 'http://localhost:3000',
  credentials: true,
}));
app.use(express.json());
app.use(cookieParser());

// ✅ Static Assets
app.use('/images', express.static(path.join(__dirname, 'public/images')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ✅ Main API Routes
app.use('/api/auth', require('./routes/auth'));                     // User login/register
app.use('/api/users', require('./routes/user'));                   // User account & profile
app.use('/api/vendors', require('./routes/vendors'));              // Vendor features
app.use('/api/products', require('./routes/products'));            // Product catalog
app.use('/api/orders', require('./routes/order'));                 // User orders
app.use('/api/cart', require('./routes/cart'));                    // User cart

// ✅ Admin API Routes (merged)
app.use('/api/admin', require('./routes/admin'));            // Admin login, dashboard, orders

// ✅ Catch-all for unknown routes
app.use((req, res) => {
  console.warn(`❌ Unmatched route: ${req.originalUrl}`);
  res.status(404).json({ message: 'Route not found' });
});

// ✅ Start Server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
