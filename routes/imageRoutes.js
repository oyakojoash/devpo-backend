// routes/imageRoutes.js
const express = require('express');
const router = express.Router();
const multer = require('multer');
const mongoose = require('mongoose');
const { GridFSBucket } = mongoose.mongo;
const axios = require('axios');
const cloudinary = require('../config/cloudinary'); // make sure this uses module.exports
const { protectAdmin } = require('../middleware/protectAdmin');

// -------------------- MULTER CONFIG --------------------
const storage = multer.memoryStorage();
const upload = multer({ storage });

// -------------------- UPLOAD IMAGE TO CLOUDINARY + GRIDFS --------------------
router.post('/upload', protectAdmin, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'No file uploaded' });

    // 1️⃣ Upload to Cloudinary
    const cloudResult = await new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          folder: 'website_uploads',
          public_id: req.file.originalname,
          resource_type: 'auto',
        },
        (error, result) => {
          if (error) reject(error);
          else resolve(result);
        }
      );
      uploadStream.end(req.file.buffer);
    });

    console.log('✅ Uploaded to Cloudinary:', cloudResult.secure_url);

    // 2️⃣ Upload to GridFS
    const db = mongoose.connection.db;
    const bucket = new GridFSBucket(db, { bucketName: 'uploads' });

    const gridUploadStream = bucket.openUploadStream(req.file.originalname, {
      contentType: req.file.mimetype,
    });
    gridUploadStream.end(req.file.buffer);

    gridUploadStream.on('error', (err) => {
      console.error('⚠️ GridFS backup failed:', err.message);
    });

   gridUploadStream.on('finish', () => {
  console.log('✅ Backup stored in GridFS:', req.file.originalname);

  return res.status(201).json({
    message: 'Upload successful',
    filename: req.file.originalname,

    primary: {
      service: 'Cloudinary',
      url: cloudResult.secure_url,
      public_id: cloudResult.public_id,
    },
    backup: {
      service: 'GridFS',
      id: gridUploadStream.id,
      filename: req.file.originalname,
      url: `/api/images/${req.file.originalname}`,
    },
  });
});

  } catch (err) {
    console.error('❌ Error during upload:', err);
    res.status(500).json({ message: 'Error processing upload', error: err.message });
  }
});

// -------------------- DELETE IMAGE FROM GRIDFS --------------------
router.delete('/:fileId', protectAdmin, async (req, res) => {
  try {
    const { fileId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(fileId))
      return res.status(400).json({ message: 'Invalid file ID' });

    const db = mongoose.connection.db;
    const bucket = new GridFSBucket(db, { bucketName: 'uploads' });

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

// -------------------- GET IMAGE --------------------


// ✅ GET /api/images/:filename
router.get("/:filename", async (req, res) => {
  const { filename } = req.params;

  try {
    // 1️⃣ Build the Cloudinary URL safely
    const folder = process.env.CLOUDINARY_FOLDER || "website_seed"; // your folder
    const encodedFilename = encodeURIComponent(filename); // handles spaces/symbols
    const cloudinaryUrl = `https://res.cloudinary.com/${process.env.CLOUDINARY_CLOUD_NAME}/image/upload/${folder}/${encodedFilename}`;

    // 2️⃣ Try to fetch from Cloudinary first
    try {
      const response = await axios.get(cloudinaryUrl, { responseType: "stream" });
      res.set("Content-Type", response.headers["content-type"]);
      response.data.pipe(res);
      return; // ✅ done — served from Cloudinary
    } catch (cloudErr) {
      console.warn(`⚠️ Cloudinary failed for ${filename}, falling back to GridFS`);
    }

    // 3️⃣ Fallback to GridFS (backup)
    const db = mongoose.connection.db;
    const bucket = new GridFSBucket(db, { bucketName: "uploads" });

    const files = await db.collection("uploads.files").find({ filename }).toArray();

    if (!files || files.length === 0) {
      return res.status(404).json({
        message: "File not found in Cloudinary or GridFS",
      });
    }

    const file = files[0];
    res.set("Content-Type", file.contentType || "application/octet-stream");

    const downloadStream = bucket.openDownloadStreamByName(filename);
    downloadStream.on("error", (err) => {
      console.error("GridFS stream error:", err);
      res.status(500).json({ message: "Error retrieving file from backup" });
    });

    downloadStream.pipe(res);
  } catch (err) {
    console.error("Unexpected error:", err);
    res.status(500).json({ message: "Error retrieving image" });
  }
});

module.exports = router;


// ✅ Export router (CommonJS)
module.exports = router;
