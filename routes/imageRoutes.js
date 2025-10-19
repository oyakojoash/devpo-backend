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
router.get('/:filename', (req, res) => {
  const { filename } = req.params;
  const gfs = req.app.locals.gfs;
  const fallback = path.join(__dirname, '../public/images/fallback.jpeg');

  if (!gfs) {
    const localPath = path.join(__dirname, '../public/images', filename);
    return fs.existsSync(localPath)
      ? res.sendFile(localPath)
      : fs.existsSync(fallback)
      ? res.sendFile(fallback)
      : res.status(404).end();
  }

  const readStream = gfs.createReadStream({ filename });

  readStream.on('error', () => {
    const localPath = path.join(__dirname, '../public/images', filename);
    if (fs.existsSync(localPath)) return res.sendFile(localPath);
    if (fs.existsSync(fallback)) return res.sendFile(fallback);
    res.status(404).end();
  });

  res.set('Content-Type', 'application/octet-stream');
  readStream.pipe(res);
});

module.exports = router;
