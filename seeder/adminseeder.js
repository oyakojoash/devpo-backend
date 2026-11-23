require('dotenv').config();
const mongoose = require('mongoose');
const Admin = require('../models/adminmodels');

async function seedAdmin() {
  const { MONGO_URI, ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_NAME } = process.env;
  if (!MONGO_URI || !ADMIN_EMAIL || !ADMIN_PASSWORD || !ADMIN_NAME) {
    throw new Error('Set MONGO_URI, ADMIN_EMAIL, ADMIN_PASSWORD, and ADMIN_NAME before running the admin seeder');
  }
  if (ADMIN_PASSWORD.length < 12) throw new Error('ADMIN_PASSWORD must be at least 12 characters');

  await mongoose.connect(MONGO_URI);
  const email = ADMIN_EMAIL.trim().toLowerCase();
  const existing = await Admin.findOne({ email });
  if (existing) {
    console.log('Admin already exists; no changes made.');
    return;
  }
  await Admin.create({ fullName: ADMIN_NAME.trim(), email, password: ADMIN_PASSWORD });
  console.log(`Admin created for ${email}.`);
}

seedAdmin().catch((error) => {
  console.error('Admin seeding failed:', error.message);
  process.exitCode = 1;
}).finally(async () => {
  await mongoose.disconnect();
});