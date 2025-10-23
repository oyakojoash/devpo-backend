const mongoose = require('mongoose');
const dotenv = require('dotenv');
const Vendor = require('../models/Vendor'); // adjust if in different path

dotenv.config();

mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/dvepo', {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
.then(() => console.log('✅ Connected to MongoDB'))
.catch((err) => {
  console.error('❌ MongoDB connection error:', err.message);
  process.exit(1);
});

const vendors = [
  {
    id: 'vendor1',
    name: 'Berry luxe bags',
    logo: "berrylogo.jpeg", // ✅ match actual image
    description: 'Affordable tech gadgets and accessories.',
  },
]

async function seedVendors() {
  try {
    await Vendor.deleteMany(); // clean old vendors
    const inserted = await Vendor.insertMany(vendors);
    console.log(`✅ Seeded ${inserted.length} vendors successfully!`);
    process.exit(0);
  } catch (err) {
    console.error('❌ Seeding failed:', err.message);
    process.exit(1);
  }
}

seedVendors();
