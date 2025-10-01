// routes/images.js
const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');

// GET /images/:filename
router.get('/:filename', (req, res) => {
  const { filename } = req.params;
  const gfs = req.app.locals.gfs;

  // ✅ Try GridFS first
  if (gfs) {
    gfs.files.findOne({ filename }, (err, file) => {
      if (file && !err) {
        const readstream = gfs.createReadStream(file.filename);
        res.set('Content-Type', file.contentType || 'application/octet-stream');
        return readstream.pipe(res);
      }

      // ✅ If not in GridFS, try local folder
      const localPath = path.join(__dirname, '../public/images', filename);
      if (fs.existsSync(localPath)) return res.sendFile(localPath);

      // ✅ Fallback image
      return res.sendFile(path.join(__dirname, '../public/images/fallback.jpeg'));
    });
  } else {
    // If GridFS not initialized, just check local folder
    const localPath = path.join(__dirname, '../public/images', filename);
    if (fs.existsSync(localPath)) return res.sendFile(localPath);

    return res.sendFile(path.join(__dirname, '../public/images/fallback.jpeg'));
  }
});

module.exports = router;
