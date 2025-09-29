const express = require("express");
const router = express.Router();
const multer = require("multer");
const { GridFsStorage } = require("multer-gridfs-storage");
const Image = require("../models/Image");

const MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/myshop";

// configure multer-gridfs-storage
const storage = new GridFsStorage({
  url: MONGO_URI,
  file: (req, file) => ({
    filename: `${Date.now()}-${file.originalname}`,
    bucketName: "uploads"
  })
});

const upload = multer({ storage });

// upload single image
router.post("/upload", upload.single("image"), async (req, res) => {
  try {
    const imgDoc = await Image.create({
      filename: req.file.filename,
      caption: req.body.caption || ""
    });
    res.json(imgDoc);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// stream image by filename
router.get("/file/:filename", (req, res) => {
  const gfs = req.app.locals.gfs;
  if (!gfs) return res.status(500).json({ error: "GridFS not initialized" });

  gfs.files.findOne({ filename: req.params.filename }, (err, file) => {
    if (!file || err) return res.status(404).json({ error: "File not found" });
    const readstream = gfs.createReadStream(file.filename);
    res.set("Content-Type", file.contentType || "application/octet-stream");
    readstream.pipe(res);
  });
});

module.exports = router;
