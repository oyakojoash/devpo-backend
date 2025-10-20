const express = require('express');
const router = express.Router();
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { protectAdmin } = require('../middleware/protectAdmin');

// -------------------- MULTER CONFIG --------------------
const storage = multer.memoryStorage(); // store file in memory
const upload = multer({ storage });

// -------------------- UPLOAD IMAGE --------------------
router.post('/upload', protectAdmin, upload.single('image'), async (req, res) => {
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
        filename,
        url: `/api/images/${filename}`,
      });
    });

    uploadStream.on('error', (err) => {
      console.error('GridFS upload error:', err);
      res.status(500).json({ message: 'Error uploading file' });
    });

  } catch (err) {
    console.error('Server error during upload:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// -------------------- DOWNLOAD IMAGE --------------------
router.get('/api/images/:filename', async (req, res) => {
  const { filename } = req.params;
  const gfsBucket = req.app.locals.gfsBucket;
  const fallback = path.join(__dirname, '../public/images/fallback.jpeg');

  const sendFallback = () => {
    const localPath = path.join(__dirname, '../public/images', filename);
    if (fs.existsSync(localPath)) return res.sendFile(localPath);
    if (fs.existsSync(fallback)) return res.sendFile(fallback);
    return res.status(404).json({ message: 'File not found' });
  };

  if (!gfsBucket) return sendFallback();

  try {
    const downloadStream = gfsBucket.openDownloadStreamByName(filename);

    downloadStream.on('error', (err) => {
      console.error('GridFS download error:', err);
      sendFallback();
    });

    // Set MIME type based on extension
    const ext = path.extname(filename).toLowerCase();
    const mimeTypes = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp',
    };
    res.set('Content-Type', mimeTypes[ext] || 'application/octet-stream');

    downloadStream.pipe(res);

  } catch (err) {
    console.error('Error fetching file from GridFS:', err);
    sendFallback();
  }
});

module.exports = router;
