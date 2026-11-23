const express = require('express');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const { protectMerchant } = require('../middleware/protectMerchant');
const { createStoryController } = require('../controllers/storyController');

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const allowedMimeTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4', 'video/webm']);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 2, parts: 3 },
  fileFilter(_req, file, callback) {
    if (!allowedMimeTypes.has(file.mimetype)) {
      const error = new Error('Unsupported story media type');
      error.status = 400;
      return callback(error);
    }
    return callback(null, true);
  },
});
const viewLimiter = rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: true, legacyHeaders: false });
const publishLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false });

function createStoriesRouter({ protect = protectMerchant, controller = createStoryController(), viewRateLimit = viewLimiter, publishRateLimit = publishLimiter } = {}) {
  const router = express.Router();
  const uploadStoryMedia = (req, res, next) => upload.single('media')(req, res, (error) => {
    if (!error) return next();
    if (error.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ success: false, message: 'Media exceeds the 50 MB upload limit' });
    return res.status(error.status || 400).json({ success: false, message: error.message || 'Invalid story upload' });
  });

  router.post('/', protect, publishRateLimit, uploadStoryMedia, controller.publish);
  router.get('/', controller.active);
  router.get('/my', protect, controller.mine);
  router.get('/merchants/:merchantId', controller.merchantActive);
  router.post('/:storyId/views', viewRateLimit, controller.view);
  router.delete('/:storyId', protect, controller.remove);
  return router;
}

module.exports = createStoriesRouter;
