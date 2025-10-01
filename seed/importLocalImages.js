const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const Image = require("../models/Image");

// Load environment variables
require("dotenv").config();

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
  console.error("Error: MONGO_URI is not defined. Please set it in your .env file.");
  process.exit(1);
}

const IMAGES_DIR = path.join(__dirname, "../public/images");

(async () => {
  try {
    await mongoose.connect(MONGO_URI);
    console.log("MongoDB connected!");

    const conn = mongoose.connection;
    const bucket = new mongoose.mongo.GridFSBucket(conn.db, { bucketName: "uploads" });

    const files = fs
      .readdirSync(IMAGES_DIR)
      .filter((f) => /\.(jpg|jpeg|png|gif)$/i.test(f));

    for (const file of files) {
      // Check if file already exists
      const exists = await conn.db.collection("uploads.files").findOne({ filename: file });
      if (exists) continue;

      await new Promise((resolve, reject) => {
        const readStream = fs.createReadStream(path.join(IMAGES_DIR, file));
        const uploadStream = bucket.openUploadStream(file);
        readStream
          .pipe(uploadStream)
          .on("error", reject)
          .on("finish", async () => {
            await Image.create({ filename: file });
            console.log("Stored:", file);
            resolve();
          });
      });
    }

    console.log("All local images imported to GridFS + Image collection");
    process.exit(0); // exit cleanly
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
})();
