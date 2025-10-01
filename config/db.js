const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const Image = require("../models/Image");
const connectDB = require("../config/db");

// Load environment variables
require("dotenv").config();

const IMAGES_DIR = path.join(__dirname, "../public/images");

(async () => {
  try {
    // Connect to MongoDB
    await connectDB();

    const conn = mongoose.connection;
    const bucket = new mongoose.mongo.GridFSBucket(conn.db, { bucketName: "uploads" });

    // Get all image files
    const files = fs
      .readdirSync(IMAGES_DIR)
      .filter((f) => /\.(jpg|jpeg|png|gif)$/i.test(f));

    console.log("Files to import:", files);

    for (const file of files) {
      // Check if file already exists in GridFS
      const exists = await conn.db.collection("uploads.files").findOne({ filename: file });
      if (exists) {
        console.log(`Skipping existing file: ${file}`);
        continue;
      }

      // Upload file to GridFS
      await new Promise((resolve, reject) => {
        const readStream = fs.createReadStream(path.join(IMAGES_DIR, file));
        const uploadStream = bucket.openUploadStream(file);

        readStream
          .pipe(uploadStream)
          .on("error", reject)
          .on("finish", async () => {
            // Save file reference in Image collection
            await Image.create({ filename: file });
            console.log("Stored:", file);
            resolve();
          });
      });
    }

    console.log("✅ All local images imported to GridFS + Image collection");
    process.exit(0); // exit cleanly
  } catch (err) {
    console.error("❌ Seeder failed:", err);
    process.exit(1);
  }
})();
