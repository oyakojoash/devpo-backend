const mongoose = require('mongoose');

const VendorSchema = new mongoose.Schema({
  id: {
    type: String,
    required: true,
    unique: true, // keep the same 'vendor1', 'vendor2' structure
  },
  name: {
    type: String,
    required: true,
  },
  logo: {
    type: String,
    required: true,
  },
  description: {
    type: String,
    required: true,
  },
});

module.exports = mongoose.model('Vendor', VendorSchema);
