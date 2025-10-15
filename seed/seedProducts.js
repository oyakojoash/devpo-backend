const mongoose = require("mongoose");
const dotenv = require("dotenv");
const Product = require("../models/Product");
const Image = require("../models/Image"); // <-- new import

dotenv.config();

async function updateProductImagesAndDescriptions() {
  try {
    console.log("🌍 Connecting to MongoDB...");
    await mongoose.connect(process.env.MONGO_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log("✅ Connected to MongoDB Atlas");

    const images = await Image.find();

    if (!images.length) {
      console.log("⚠️ No images found in DB. Upload some first.");
      return process.exit(0);
    }

    // 🧠 Define mapping: product name -> image + description
    const updatedProducts = [
      {
        name: "Wireless Mouse 1",
        image: images[0],
        details:
          "A lightweight wireless mouse with ergonomic design, adjustable DPI, and 12-month battery life.",
      },
      {
        name: "Keyboard 1",
        image: images[1],
        details:
          "Compact mechanical keyboard with RGB backlighting and hot-swappable switches.",
      },
      {
        name: "Monitor 1",
        image: images[2],
        details:
          "27-inch Full HD IPS monitor with ultra-slim bezels and 75Hz refresh rate.",
      },
      {
        name: "USB-C Hub 1",
        image: images[3],
        details:
          "7-in-1 USB-C hub with HDMI output, SD card reader, and 100W power delivery support.",
      },
      {
        name: "Laptop Stand 1",
        image: images[4],
        details:
          "Adjustable aluminum laptop stand that improves posture and cooling airflow.",
      },
      {
        name: "Webcam 1",
        image: images[5],
        details:
          "1080p HD webcam with built-in dual microphones and low-light correction.",
      },
      {
        name: "Desk Lamp 1",
        image: images[6],
        details:
          "LED desk lamp with touch control, brightness settings, and USB charging port.",
      },
      {
        name: "Bluetooth Speaker 1",
        image: images[7],
        details:
          "Portable Bluetooth speaker with 10-hour playtime and deep bass sound.",
      },
      {
        name: "Wireless Mouse 2",
        image: images[0],
        details:
          "Second edition wireless mouse with upgraded optical sensor and silent buttons.",
      },
    ];

    // 🔄 Update products in MongoDB
    for (const item of updatedProducts) {
      const result = await Product.updateOne(
        { name: item.name },
        {
          $set: {
            images: [item.image._id],
            details: item.details,
          },
        }
      );
      console.log(`🖼 Updated "${item.name}" - matched: ${result.matchedCount}`);
    }

    console.log("🎉 All product images & descriptions updated successfully!");
    process.exit(0);
  } catch (err) {
    console.error("❌ Error updating products:", err);
    process.exit(1);
  }
}

updateProductImagesAndDescriptions();
