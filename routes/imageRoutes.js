// routes/imageRoutes.js
const express = require('express');
const router = express.Router();
const multer = require('multer');
const mongoose = require('mongoose');
const { GridFSBucket } = mongoose.mongo;
const { protectAdmin } = require('../middleware/protectAdmin');

// -------------------- MULTER CONFIG --------------------
// Store files temporarily in memory before saving to MongoDB
const storage = multer.memoryStorage();
const upload = multer({ storage });

// -------------------- UPLOAD IMAGE TO GRIDFS --------------------
router.post('/upload', protectAdmin, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: 'No file uploaded' });
    }

    const db = mongoose.connection.db;
    const bucket = new GridFSBucket(db, {
      bucketName: 'uploads', // This is the name of your GridFS bucket
    });

    // Open a stream to store the file in GridFS
    const uploadStream = bucket.openUploadStream(req.file.originalname);
    uploadStream.end(req.file.buffer);

    // Use the callback from openUploadStream to get the file metadata
    uploadStream.on('finish', (file) => {
      console.log('File upload finished:', file); // Log the file metadata to inspect

      // Ensure file metadata contains the _id
      if (!file || !file._id) {
        return res.status(500).json({ message: 'Failed to retrieve file metadata' });
      }

      res.status(201).json({
        message: 'File uploaded successfully',
        fileId: file._id,  // File ID will be useful for future retrieval or deletion
        fileUrl: `/api/images/${file._id}`,  // You can create an endpoint to retrieve the file by ID
      });
    });

    uploadStream.on('error', (err) => {
      console.error('Error uploading file to GridFS:', err);
      res.status(500).json({ message: 'Error uploading file to GridFS' });
    });

  } catch (err) {
    console.error('Error:', err);
    res.status(500).json({ message: 'Error processing file' });
  }
});

// -------------------- DELETE IMAGE FROM GRIDFS --------------------
router.delete('/:fileId', protectAdmin, async (req, res) => {
  try {
    const { fileId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(fileId)) {
      return res.status(400).json({ message: 'Invalid file ID' });
    }

    const db = mongoose.connection.db;
    const bucket = new GridFSBucket(db, {
      bucketName: 'uploads',
    });

    bucket.delete(new mongoose.Types.ObjectId(fileId), (err) => {
      if (err) {
        console.error('Error deleting file from GridFS:', err);
        return res.status(500).json({ message: 'Error deleting file from GridFS' });
      }
      res.json({ message: 'File deleted successfully' });
    });
  } catch (err) {
    console.error('Error deleting file:', err);
    res.status(500).json({ message: 'Error processing deletion' });
  }
});

module.exports = router;
