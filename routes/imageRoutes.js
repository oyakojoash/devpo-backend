// routes/upload.js
const express = require('express');
const router = express.Router();
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const cloudinary = require('cloudinary').v2;
const { protectAdmin } = require('../middleware/protectAdmin');

// -------------------- CLOUDINARY CONFIG --------------------
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// -------------------- MULTER CONFIG --------------------
// Store temporarily on disk before upload
const upload = multer({ dest: 'uploads/' });

// -------------------- UPLOAD IMAGE TO CLOUDINARY --------------------
router.post('/upload', protectAdmin, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: 'No file uploaded' });
    }

    // Upload to Cloudinary
    const result = await cloudinary.uploader.upload(req.file.path, {
      folder: 'ecommerce_uploads', // optional folder name
      resource_type: 'auto',       // supports images/videos
    });

    // Remove local temp file
    fs.unlinkSync(req.file.path);

    // Send Cloudinary response
    res.status(201).json({
      message: 'File uploaded successfully',
      url: result.secure_url, // Save this URL in MongoDB
      public_id: result.public_id, // Useful for deleting later if needed
    });
  } catch (err) {
    console.error('Cloudinary upload error:', err);
    res.status(500).json({ message: 'Error uploading file' });
  }
});

// -------------------- DELETE IMAGE FROM CLOUDINARY --------------------
router.delete('/:public_id', protectAdmin, async (req, res) => {
  try {
    const { public_id } = req.params;

    const result = await cloudinary.uploader.destroy(public_id);
    if (result.result === 'not found') {
      return res.status(404).json({ message: 'Image not found' });
    }

    res.json({ message: 'Image deleted successfully' });
  } catch (err) {
    console.error('Error deleting image from Cloudinary:', err);
    res.status(500).json({ message: 'Server error during delete' });
  }
});

module.exports = router;
