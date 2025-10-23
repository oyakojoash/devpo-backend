const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const Image = require("../models/Image");
const connectDB = require("../config/db");
const cloudinary = require("../config/cloudinaryConfig"); // cloudinary config file

require("dotenv").config();

const IMAGES_DIR = path.join(__dirname, "../public/images");

(async () => {
  try {
    await connectDB();
    console.log("✅ Connected to MongoDB");

    const files = fs
      .readdirSync(IMAGES_DIR)
      .filter((f) => /\.(jpg|jpeg|png|gif)$/i.test(f));

    console.log("Files to upload:", files);

    for (const file of files) {
      const filePath = path.join(IMAGES_DIR, file);

      // Check if already exists in Image collection
      const exists = await Image.findOne({ filename: file });
      if (exists) {
        console.log(`Skipping existing file: ${file}`);
        continue;
      }

      // Upload to Cloudinary
      const result = await cloudinary.uploader.upload(filePath, {
        folder: "products", // optional folder in Cloudinary
      });

      // Save to MongoDB
      await Image.create({
        filename: file,
        url: result.secure_url,
        public_id: result.public_id,
      });

      console.log(`✅ Uploaded and stored: ${file}`);
    }

    console.log("✅ All local images uploaded to Cloudinary + Image collection");
    process.exit(0);
  } catch (err) {
    console.error("❌ Seeder failed:", err);
    process.exit(1);
  }
})();
