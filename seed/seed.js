const mongoose = require('mongoose');
const Product = require('../models/Product');
const products = require('./products'); // no .js extension needed
require('dotenv').config();

mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).then(async () => {
  console.log('Connected to MongoDB');

  await Product.deleteMany({});
  await Product.insertMany(products);

  console.log('Products inserted!');
  process.exit();
}).catch(err => {
  console.error(err);
  process.exit(1);
});
console.log(products); // print your seed data
