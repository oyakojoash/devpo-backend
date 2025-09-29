const mongoose = require("mongoose");
const dotenv = require("dotenv");
const Product = require("../models/Product");
const Image = require("../models/Image"); // <-- new import

dotenv.config();

async function updateProductImages() {
  try {
    console.log("🌍 Connecting to MongoDB...");
    await mongoose.connect(process.env.MONGO_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log("✅ Connected to MongoDB Atlas");

    const BACKEND_URL = process.env.BACKEND_URL || "";

    // fetch all image docs from Mongo
    const images = await Image.find();

    if (!images.length) {
      console.log("⚠️ No images found in DB. Upload some first.");
      return process.exit(0);
    }

    // map product names to image filenames (adjust this mapping as you wish)
    const updatedImages = [
      { name: "Wireless Mouse 1", image: images[0] },
      { name: "Keyboard 1", image: images[1] },
      { name: "Monitor 1", image: images[2] },
      { name: "USB-C Hub 1", image: images[3] },
      { name: "Laptop Stand 1", image: images[4] },
      { name: "Webcam 1", image: images[5] },
      { name: "Desk Lamp 1", image: images[6] },
      { name: "Bluetooth Speaker 1", image: images[7] },
      { name: "Wireless Mouse 2", image: images[0] }, // reuse first image
    ];

    // update products to reference image ObjectIds
    for (const item of updatedImages) {
      const result = await Product.updateOne(
        { name: item.name },
        { $set: { images: [item.image._id] } } // <-- link Image doc
      );
      console.log(`🖼 Updated "${item.name}" - matched: ${result.matchedCount}`);
    }

    console.log("🎉 All product images linked successfully!");
    process.exit(0);
  } catch (err) {
    console.error("❌ Error updating product images:", err);
    process.exit(1);
  }
}

updateProductImages();
