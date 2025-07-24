// C:\Users\hp\Desktop\memo\proto1\backend\seeder\adminseeder.js

const mongoose = require("mongoose");
const bcrypt = require("bcrypt");
const dotenv = require("dotenv");
const path = require("path");

// ✅ Use Admin model instead of User
const Admin = require(path.join(__dirname, "..", "models", "adminmodels"));

dotenv.config();

// ✅ Connect to MongoDB
mongoose
  .connect(process.env.MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  })
  .then(() => console.log("✅ MongoDB connected"))
  .catch((err) => {
    console.error("❌ Connection error:", err.message);
    process.exit(1);
  });

const seedAdmin = async () => {
  try {
    // Optional: Wipe all existing admins (⚠️ only in dev/test)
    // await Admin.deleteMany();

    const existing = await Admin.findOne({ email: "admin@example.com" });
    if (existing) {
      console.log("⚠️ Admin already exists. Skipping...");
      return process.exit(0);
    }

    const hashedPassword = await bcrypt.hash("admin123", 10);

    const admin = new Admin({
      fullName: "Super Admin",
      email: "admin@example.com",
      password: hashedPassword,
    });

    await admin.save();
    console.log("✅ Admin created: admin@example.com / admin123");
    process.exit(0);
  } catch (err) {
    console.error("❌ Admin seeding failed:", err.message);
    process.exit(1);
  }
};

seedAdmin();
