const express = require('express');
const router = express.Router();
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { protectAdmin } = require('../middleware/protectAdmin');
const Image = require('../models/Image');

// -------------------- MULTER CONFIG --------------------
const storage = multer.memoryStorage(); // store file in memory
const upload = multer({ storage });

router.post('/upload', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'No file uploaded' });

    const gfsBucket = req.app.locals.gfsBucket;
    if (!gfsBucket) return res.status(500).json({ message: 'GridFSBucket not initialized' });

    // Generate random filename
    const filename = crypto.randomBytes(16).toString('hex') + path.extname(req.file.originalname);

    const uploadStream = gfsBucket.openUploadStream(filename, {
      contentType: req.file.mimetype,
    }); 
    uploadStream.end(req.file.buffer);

    uploadStream.on('finish', () => {
      res.status(201).json({
        message: 'Image uploaded successfully',
        filename: filename,
        url: `/api/images/${filename}`,
      });
    });

    uploadStream.on('error', (err) => {
      console.error(err);
      res.status(500).json({ message: 'Error uploading file' });
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});
// -------------------- DOWNLOAD IMAGE --------------------
router.get("/api/images/:filename", async (req, res) => {
  const { filename } = req.params;
  const gfs = req.app.locals.gfs;
  const fallback = path.join(__dirname, '../public/images/fallback.jpeg');

  // Helper for fallback logic
  const sendFallback = () => {
    const localPath = path.join(__dirname, '../public/images', filename);
    if (fs.existsSync(localPath)) return res.sendFile(localPath);
    if (fs.existsSync(fallback)) return res.sendFile(fallback);
    return res.status(404).end();
  };

  // If GridFS not initialized, fallback immediately
  if (!gfs) return sendFallback();

  try {
    // Check if file exists in GridFS first
    const file = await gfs.files.findOne({ filename });
    if (!file) return sendFallback();

    // Set the correct MIME type
    const contentType =
      file.contentType ||
      (filename.endsWith('.png')
        ? 'image/png'
        : filename.endsWith('.jpg') || filename.endsWith('.jpeg')
        ? 'image/jpeg'
        : filename.endsWith('.webp')
        ? 'image/webp'
        : 'application/octet-stream');

    res.set('Content-Type', contentType);

    const readStream = gfs.createReadStream({ filename });

    // Handle stream errors
    readStream.on('error', (err) => {
      console.error('GridFS stream error:', err);
      sendFallback();
    });

    // Stream file
    readStream.pipe(res);
  } catch (err) {
    console.error('GridFS file fetch error:', err);
    sendFallback();
  }
});
module.exports = router;
