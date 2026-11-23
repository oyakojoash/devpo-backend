const express = require('express');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');
const Order = require('./models/Order');
const Conversation = require('./models/Conversation');
const Message = require('./models/Message');
const { ensureOrderIdempotencyIndex } = require('./utils/orderIndexReadiness');
const { ensureMessagingIndexes } = require('./utils/messagingIndexReadiness');

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT) || 10000;
const allowedOrigins = new Set([
  'https://dvepo.com',
  'https://dvepo.netlify.app',
  'https://dvepoadmin.netlify.app',
  'https://devpo-frontend.onrender.com',
  'https://devpo1-frontend.onrender.com',
  'http://localhost:3000',
]);

if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required');
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  throw new Error('JWT_SECRET must be configured with at least 32 characters');
}

app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet());
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.has(origin)) return callback(null, true);
    const error = new Error('Origin not allowed');
    error.status = 403;
    return callback(error);
  },
  credentials: true,
}));
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
const publicImageDir = path.join(__dirname, 'public', 'images');
const staticImageOptions = {
  maxAge: '1d',
  fallthrough: true,
  index: false,
  setHeaders(res) {
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  },
};
app.use('/images/vendors', express.static(publicImageDir, staticImageOptions));
app.use('/images', express.static(publicImageDir, staticImageOptions));

// SameSite=None cookies are needed by the deployed cross-origin frontend.
// Require an allowlisted Origin on browser mutations that carry an auth cookie.
app.use((req, res, next) => {
  const mutation = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method);
  const hasAuthCookie = Boolean(req.cookies?.token || req.cookies?.adminToken || req.cookies?.merchantToken);
  if (mutation && hasAuthCookie && (!req.get('origin') || !allowedOrigins.has(req.get('origin')))) {
    return res.status(403).json({ message: 'Request origin is not allowed' });
  }
  next();
});

const imageRoutes = require('./routes/imageRoutes');
const productRoutes = require('./routes/products');
const cartRoutes = require('./routes/cart');
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/user');
const orderRoutes = require('./routes/order');
const vendorsRoutes = require('./routes/vendors');
const adminRoutes = require('./routes/admin');
const { createMerchantAuthRouter } = require('./routes/merchantAuth');
const { createMerchantProductsRouter } = require('./routes/merchantProducts');
const { createMerchantStoreRouter } = require('./routes/merchantStore');
const merchantOrderRoutes = require('./routes/merchantOrders');
const messagesRoutes = require('./routes/messages');
const storiesRoutes = require('./routes/stories');

app.use('/api/images', (req, res, next) => {
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  next();
}, imageRoutes);
app.use('/api/products', productRoutes);
app.use('/api/cart', cartRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/user', userRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/vendors', vendorsRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/merchant-auth', createMerchantAuthRouter());
app.use('/api/merchant/store', createMerchantStoreRouter());
app.use('/api/merchant/orders', merchantOrderRoutes);
app.use('/api/merchant/products', createMerchantProductsRouter());
app.use('/api/messages', messagesRoutes());
app.use('/api/stories', storiesRoutes());

app.get('/', (req, res) => res.send('API is running'));
app.use((req, res) => res.status(404).json({ error: 'Route not found' }));
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'Uploaded image exceeds the 5 MB limit' });
  if (err.status && err.status < 500) return res.status(err.status).json({ error: err.message });
  console.error('Request failed:', err.message);
  return res.status(500).json({ error: 'Internal server error' });
});

async function start({
  dbConnection = mongoose,
  orderModel = Order,
  expressApp = app,
  port = PORT,
  processHooks = process,
  logger = console,
  messagingIndexReadiness,
} = {}) {
  await dbConnection.connect(process.env.MONGO_URI, { maxPoolSize: 20 });

  try {
    await ensureOrderIdempotencyIndex(orderModel);
  } catch (error) {
    logger.error('Required Order idempotency index is not ready; HTTP server will not start.', {
      name: error?.name || 'Error',
      code: error?.code || 'INDEX_NOT_READY',
    });
    throw new Error('Required Order idempotency index is not ready');
  }

  try {
    // Injected fake connections used by startup unit tests do not own the app's Mongoose models.
    if (messagingIndexReadiness) await messagingIndexReadiness();
    else if (dbConnection === mongoose) await ensureMessagingIndexes(Conversation, Message);
  } catch (error) {
    logger.error('Required Messaging indexes are not ready; HTTP server will not start.', {
      name: error?.name || 'Error',
      code: error?.code || 'MESSAGING_INDEX_NOT_READY',
    });
    throw new Error('Required Messaging indexes are not ready');
  }

  const db = dbConnection.connection.db;
  expressApp.locals.gfsBucket = new dbConnection.mongo.GridFSBucket(db, { bucketName: 'uploads' });
  const server = expressApp.listen(port, () => logger.log(`Server listening on port ${port}`));

  const shutdown = async () => {
    server.close(async () => {
      await dbConnection.disconnect();
      processHooks.exit(0);
    });
  };
  processHooks.on('SIGINT', shutdown);
  processHooks.on('SIGTERM', shutdown);
  return server;
}

if (require.main === module) {
  start().catch((err) => {
    console.error('Backend startup failed:', err.message);
    process.exit(1);
  });
}

module.exports = { app, start };
