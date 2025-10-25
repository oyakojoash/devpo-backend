const mongoose = require("mongoose");
const dotenv = require("dotenv");
const Product = require("../models/Product");
const Image = require("../models/Image");

dotenv.config();

// Connect to MongoDB
async function connectDB() {
  await mongoose.connect(process.env.MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  });
  console.log("✅ Connected to MongoDB Atlas");
}

// Bulk insert / replace products
async function seedProducts(productsData) {
  try {
    const inserted = await Product.insertMany(productsData);
    console.log(`✅ ${inserted.length} products added successfully`);
  } catch (err) {
    console.error("❌ Bulk seeding failed:", err);
  }
}

// Main function
async function main() {
  await connectDB();

  // Optional: fetch images from MongoDB
  const images = await Image.find().sort({ uploadedAt: 1 });

  // Define products array
  const updatedProducts = [
    {
      name: "Beige sling bag",
      image: "Beige sling bag.jpeg",
      description: "A very good for outings.",
      price: 950,
      vendorId: "vendor1",
    },
    {
      name: "Cute yellow bag",
      image: "Cute yellow bag.jpeg",
      description: "Make you stand out.",
      price: 1000,
      vendorId: "vendor1",
    },
    {
      name: "Cute maroon bag",
      image: "Cute maroon bag.jpeg",
      description: "Make you stand out.",
      price: 950,
      vendorId: "vendor1",
    },
    {
      name: "White shoulder bag",
      image: "White shoulder bag.jpeg",
      description: "Elegant and simple for daily use.",
      price: 950,
      vendorId: "vendor1",
    },
    {
      name: "Baby pink shoulder bag",
      image: "Baby pink shoulder bag.jpeg",
      description: "Cute and stylish for every occasion.",
      price: 950,
      vendorId: "vendor1",
    },
    {
      name: "New HP 645 G5",
      image: "New HP 645 G5.jpeg",
      description:
        "Ryzen 7 PRO\n2GB Dedicated Graphics\n8GB RAM\n256GB SSD\n8th Generation\n14 inches screen\nFHD Display\n2.7 GHz speed with TurboBoost Up to 5.0GHz\nBacklit keyboard\nPre-installed Windows 11 and Microsoft Office 2021\nComes with 1 Year warranty.\nCountrywide delivery available.",
      price: 34000,
      vendorId: "vendor2",
    },
    {
      name: "HP Elitebook 840G3",
      image: "HP Elitebook 840G3.jpeg",
      description:
        "Intel Core i7\n8GB RAM\n256GB SSD\n14 inches screen\nBacklit keyboard\nPre-installed Windows 11 and Microsoft Office 2021\nComes with 1 Year warranty.\nCountrywide delivery available.",
      price: 32000,
      vendorId: "vendor2",
    },
    {
      name: "New HP ProBook 640 G5",
      image: "New HP ProBook 640 G5.jpeg",
      description:
        "Intel Core i5\n8GB RAM\n256GB SSD\n8th Generation\n14 inches screen\nFHD Display\n2.7 GHz speed with TurboBoost Up to 5.0GHz\nBacklit keyboard\nPre-installed Windows 11 and Microsoft Office 2021\nComes with 1 Year warranty.",
      price: 32000,
      vendorId: "vendor2",
    },
    {
      name: "New HP ProBook 11 G4",
      image: "New HP ProBook 11 G4.jpeg",
      description:
        "Intel Core i5\n8th Generation\n8GB RAM\n256GB SSD\nX360 Touchscreen (2 in 1)\nPre-installed Windows 11 and Microsoft Office 2021\nComes with 1 Year warranty.",
      price: 28000,
      vendorId: "vendor2",
    },
    {
      name: "HP ElitePad 1000 G2",
      image: "HP ElitePad 1000 G2.jpeg",
      description:
        "Processor: Intel Atom CPU Z3795\nSpeed: 1.60 GHz\nMemory: 4GB RAM\nStorage: 64GB ROM (expandable via SD card)\nNetwork: Wi-Fi cellular\nComes with a Docking Station (4 USB ports, HDMI, VGA, Ethernet port, Jackpin, and Lock).",
      price: 28000,
      vendorId: "vendor2",
    },
  ];

  // Bulk insert / replace
  await seedProducts(updatedProducts);

  process.exit(0);
}

// Run main
main();
