const mongoose = require("mongoose");
const dotenv = require("dotenv");
const Product = require("../models/Product");
const Image = require("../models/Image");

dotenv.config();

// ----------------------------------
// Connect to MongoDB
// ----------------------------------
async function connectDB() {
  await mongoose.connect(process.env.MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  });
  console.log("✅ Connected to MongoDB Atlas");
}

// ----------------------------------
// Full replace / bulk insert products
// ----------------------------------
async function seedProducts(productsData) {
  try {
  
    const inserted = await Product.insertMany(productsData);
    console.log(`✅ ${inserted.length} products added successfully`);
  } catch (err) {
    console.error("❌ Bulk seeding failed:", err);
  }
}

// ----------------------------------
// Add or update a single product
// ----------------------------------
async function upsertProduct(productData) {
  try {
    const result = await Product.updateOne(
      { name: productData.name },
      { $set: productData },
      { upsert: true }
    );

    if (result.upsertedCount > 0) {
      console.log(`✅ Product "${productData.name}" added`);
    } else if (result.modifiedCount > 0) {
      console.log(`🔄 Product "${productData.name}" updated`);
    } else {
      console.log(`⚠️ Product "${productData.name}" already up-to-date`);
    }
  } catch (err) {
    console.error(`❌ Failed to upsert "${productData.name}":`, err);
  }
}

// ----------------------------------
// Remove a single product
// ----------------------------------
async function removeProduct(name) {
  try {
    const result = await Product.deleteOne({ name });
    if (result.deletedCount === 0) {
      console.log(`⚠️ Product "${name}" not found`);
    } else {
      console.log(`🗑️ Product "${name}" removed`);
    }
  } catch (err) {
    console.error(`❌ Failed to remove "${name}":`, err);
  }
}

// ----------------------------------
// Main function
// ----------------------------------
async function main() {
  await connectDB();

  // Fetch images from MongoDB
  const images = await Image.find().sort({ uploadedAt: 1 });

  // Define products array after images are fetched
  const updatedProducts = [
    {
      name: "Wireless Mouse 1",
      image: images[0].filename,
      details: "A lightweight wireless mouse with ergonomic design, adjustable DPI, and 12-month battery life.",
      price: 25.99,
      vendorId: "vendor1",
    },
    {
      name: "Keyboard 1",
      image: images[1].filename,
      details: "Compact mechanical keyboard with RGB backlighting and hot-swappable switches.",
      price: 45.5,
      vendorId: "vendor1",
    },
    {
      name: "Monitor 1",
      image: images[2].filename,
      details: "27-inch Full HD IPS monitor with ultra-slim bezels and 75Hz refresh rate.",
      price: 179.99,
      vendorId: "vendor2",
    },
    {
      name: "USB-C Hub 1",
      image: images[3].filename,
      details: "7-in-1 USB-C hub with HDMI output, SD card reader, and 100W power delivery support.",
      price: 39.99,
      vendorId: "vendor2",
    },
    {
      name: "Laptop Stand 1",
      image: images[4].filename,
      details: "Adjustable aluminum laptop stand that improves posture and cooling airflow.",
      price: 29.99,
      vendorId: "vendor3",
    },
    {
      name: "Webcam 1",
      image: images[5].filename, // ✅ fixed img5.jpeg
      details: "1080p HD webcam with built-in dual microphones and low-light correction.",
      price: 55.0,
      vendorId: "vendor3",
    },
    {
      name: "Desk Lamp 1",
      image: images[6]?.filename || images[0].filename, // fallback if not enough images
      details: "LED desk lamp with touch control, brightness settings, and USB charging port.",
      price: 22.5,
      vendorId: "vendor1",
    },
    {
      name: "Bluetooth Speaker 1",
      image: images[7]?.filename || images[1].filename,
      details: "Portable Bluetooth speaker with 10-hour playtime and deep bass sound.",
      price: 49.99,
      vendorId: "vendor2",
    },
    {
      name: "Wireless Mouse 2",
      image: images[0].filename,
      details: "Second edition wireless mouse with upgraded optical sensor and silent buttons.",
      price: 29.99,
      vendorId: "vendor1",
    },
  ];

  // Bulk insert / replace all
  await seedProducts(updatedProducts);

  // Example: single add/update
  await upsertProduct({
    name: "Wireless Headphones",
    image: images[7]?.filename || images[0].filename,
    details: "Over-ear Bluetooth headphones with 20-hour battery life.",
    price: 59.99,
    vendorId: "vendor1",
  });

  // Example: remove a product
  // await removeProduct("Keyboard 1");

  process.exit(0);
}

main();
