// routes/imageRoutes.js
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const router = express.Router();
const multer = require('multer');
const mongoose = require('mongoose');
const { GridFSBucket } = mongoose.mongo;
const axios = require('axios');
const cloudinary = require('../config/cloudinary'); // make sure this uses module.exports
const { protectAdmin } = require('../middleware/protectAdmin');
const { protectMerchant } = require('../middleware/protectMerchant');
const Image = require('../models/Image');
const {
  getCloudinaryFolders,
  fetchCloudinaryImage,
  uploadGridFsBackup,
  getGridFsContentType,
} = require('../utils/imageStorage');

const merchantAuthDiagnosticsEnabled =
  process.env.NODE_ENV === 'development' && process.env.MERCHANT_AUTH_DIAGNOSTICS === '1';

function logImageAuthDiagnostic(req, branch) {
  if (!merchantAuthDiagnosticsEnabled) return;

  console.info('[merchant-auth-diagnostic]', {
    method: req.method,
    path: `${req.baseUrl || ''}${req.route?.path || req.path}`,
    merchantTokenPresent: Boolean(req.cookies?.merchantToken),
    adminTokenPresent: Boolean(req.cookies?.adminToken),
    branch,
  });
}

// -------------------- MULTER CONFIG --------------------
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter(req, file, callback) {
    if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.mimetype)) {
      const error = new Error('Unsupported image type');
      error.status = 400;
      return callback(error);
    }
    return callback(null, true);
  },
});

function uploadAccess(req, res, next) {
  if (req.cookies?.adminToken) {
    logImageAuthDiagnostic(req, 'admin');
    return protectAdmin(req, res, next);
  }
  logImageAuthDiagnostic(req, 'merchant');
  return protectMerchant(req, res, next);
}

function detectImageMime(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (buffer.length >= 6 && ['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

// -------------------- UPLOAD IMAGE TO CLOUDINARY + GRIDFS --------------------
router.post('/upload', uploadAccess, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'No file uploaded' });
    const detectedMime = detectImageMime(req.file.buffer);
    if (!detectedMime || detectedMime !== req.file.mimetype) return res.status(400).json({ message: 'Image content does not match a supported image type' });
    const extension = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' }[req.file.mimetype];
    const filename = crypto.randomUUID() + extension;
    const uploadFolder = getCloudinaryFolders(process.env.CLOUDINARY_FOLDER)[0];
    const cloudResult = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { folder: uploadFolder, public_id: filename, resource_type: 'image' },
        (error, result) => error ? reject(error) : resolve(result),
      );
      stream.end(req.file.buffer);
    });
    const ownerType = req.merchant ? 'merchant' : 'admin';
    const ownerId = req.merchant?._id || req.admin?._id;
    await Image.create({ filename, cloudinaryPublicId: cloudResult.public_id, ownerType, ownerId });

    let backup;
    try {
      const bucket = new GridFSBucket(mongoose.connection.db, { bucketName: 'uploads' });
      const backupStream = await uploadGridFsBackup(
        bucket,
        filename,
        req.file.buffer,
        req.file.mimetype,
      );
      backup = {
        service: 'GridFS',
        id: backupStream.id,
        filename,
        url: `/api/images/${filename}`,
        status: 'ready',
      };
    } catch (backupError) {
      console.error('GridFS image backup failed:', backupError?.code || backupError?.name || 'Error');
      backup = { service: 'GridFS', status: 'failed' };
    }

    return res.status(201).json({
      message: 'Upload successful',
      filename,
      reference: `/api/images/${encodeURIComponent(filename)}`,
      primary: { service: 'Cloudinary', url: cloudResult.secure_url, public_id: cloudResult.public_id },
      backup,
    });
  } catch (error) {
    console.error('Image upload failed:', error.message);
    return res.status(500).json({ message: 'Image upload failed' });
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
    const file = await db.collection('uploads.files').findOne({ _id: new mongoose.Types.ObjectId(fileId) });
    if (!file) return res.status(404).json({ message: 'Image not found' });
    const filename = file.filename;
    const escaped = filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const [legacyUse, merchantUse, storeUse] = await Promise.all([
      mongoose.model('Product').exists({ image: { $regex: escaped } }),
      mongoose.model('MerchantProduct').exists({ images: { $regex: escaped } }),
      mongoose.model('Vendor').exists({ $or: [{ logo: filename }, { logo: `/api/images/${filename}` }] }),
    ]);
    if (legacyUse || merchantUse || storeUse) return res.status(409).json({ message: 'Image is still referenced by a product or store' });

    if (!cloudinary.config().cloud_name) return res.status(503).json({ message: 'Cloudinary is unavailable; the image was not deleted' });
    const imageRecord = await Image.findOne({ filename }).select('cloudinaryPublicId').lean();
    const folders = getCloudinaryFolders(process.env.CLOUDINARY_FOLDER);
    const publicIds = imageRecord?.cloudinaryPublicId
      ? [imageRecord.cloudinaryPublicId]
      : folders.map((folder) => `${folder}/${path.parse(filename).name}`);
    await Promise.all(publicIds.map((publicId) => new Promise((resolve, reject) => {
      cloudinary.uploader.destroy(publicId, { resource_type: 'image' }, (error) => error ? reject(error) : resolve());
    })));
    await new Promise((resolve, reject) => bucket.delete(new mongoose.Types.ObjectId(fileId), (error) => error ? reject(error) : resolve()));
    await Image.deleteOne({ filename });
    return res.json({ message: 'File deleted successfully' });
  } catch (err) {
    console.error('Error deleting file:', err);
    res.status(500).json({ message: 'Error processing deletion' });
  }
});

// -------------------- GET IMAGE --------------------


// ✅ GET /api/images/:filename
router.get("/:filename", async (req, res) => {
  let { filename } = req.params;

  try {
    // Convert .jpeg to .jpg and encode spaces/special characters
    const cloudinaryFilename = filename.trim();

    const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
    const cloudinaryResult = await fetchCloudinaryImage({
      cloudName,
      folders: getCloudinaryFolders(process.env.CLOUDINARY_FOLDER),
      filename: cloudinaryFilename,
      fetchImage: (url, options) => axios.get(url, options),
    });

    if (cloudinaryResult) {
      const { response } = cloudinaryResult;
      res.set('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
      res.set('Content-Type', response.headers['content-type']);
      response.data.pipe(res);
      return;
    }

    console.warn(`Cloudinary image unavailable in configured and legacy folders for ${filename}; trying GridFS`);

    // Fallback to GridFS
    const db = mongoose.connection.db;
    const bucket = new GridFSBucket(db, { bucketName: "uploads" });

    const files = await db.collection("uploads.files").find({ filename }).limit(1).toArray();
    if (!files || files.length === 0) {
      return res.status(404).json({ message: "File not found in Cloudinary or GridFS" });
    }

    const file = files[0];
    res.set('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
    res.set('Content-Type', getGridFsContentType(file));

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
