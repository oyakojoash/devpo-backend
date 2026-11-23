// Run this reviewed, idempotent migration before deploying subscription routes.
// It creates only the two new collections/indexes and never drops existing indexes.
require('dotenv').config();
const mongoose = require('mongoose');
const MerchantSubscription = require('../models/MerchantSubscription');
const SubscriptionPayment = require('../models/SubscriptionPayment');

async function ensureCollection(model) {
  const db = model.db.db;
  const collectionName = model.collection.collectionName;
  const exists = await db.listCollections({ name: collectionName }, { nameOnly: true }).hasNext();
  if (!exists) await db.createCollection(collectionName);
}

async function migrate() {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required');
  await mongoose.connect(process.env.MONGO_URI, { autoIndex: false });
  try {
    for (const model of [MerchantSubscription, SubscriptionPayment]) await ensureCollection(model);
    for (const model of [MerchantSubscription, SubscriptionPayment]) {
      for (const [key, options] of model.schema.indexes()) {
        await model.collection.createIndex(key, options);
      }
    }
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  migrate().then(() => process.stdout.write('Merchant subscription indexes are ready.\n'))
    .catch((error) => {
      process.stderr.write(`Merchant subscription index migration failed: ${error.name || 'Error'}\n`);
      process.exitCode = 1;
    });
}

module.exports = { migrate, ensureCollection };
