// Reviewed, explicit index provisioning for the two referral identity collections.
// This script is never run by application startup and must be reviewed before execution.
const fs = require('node:fs');
const dotenv = require('dotenv');
const mongoose = require('mongoose');
const { REQUIRED_INDEXES } = require('../utils/affiliateReferralIndexReadiness');
const { hasSameIndexKey, hasEquivalentIndexDefinition } = require('../utils/referralIndexDefinition');

const COLLECTIONS = {
  AffiliateReferral: 'affiliatereferrals',
  AffiliateRecruitmentReferral: 'affiliaterecruitmentreferrals',
};
const SPEC = {
  AffiliateReferral: {
    indexes: REQUIRED_INDEXES.AffiliateReferral,
    fields: ['affiliate', 'affiliatePromotion', 'product', 'referralCode'],
    refs: { affiliate: 'affiliates', affiliatePromotion: 'affiliatepromotions', product: 'merchantproducts' },
  },
  AffiliateRecruitmentReferral: {
    indexes: REQUIRED_INDEXES.AffiliateRecruitmentReferral,
    fields: ['referrer', 'referralCode'],
    refs: { referrer: 'affiliates' },
  },
};

function getLocalDevDatabaseUri() {
  const env = fs.existsSync('.env') ? dotenv.parse(fs.readFileSync('.env')) : {};
  const uri = process.env.MONGO_URI || env.MONGO_URI;
  if (!uri) throw new Error('MONGO_URI is not configured');
  let parsed;
  try { parsed = new URL(uri); } catch { throw new Error('MONGO_URI is not a valid MongoDB URL'); }
  const dbName = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (!['localhost', '127.0.0.1', '::1'].includes(parsed.hostname) || dbName !== 'devpo') {
    throw new Error('Referral index provisioning is restricted to the confirmed local devpo database');
  }
  return uri;
}

const hasDefinition = hasEquivalentIndexDefinition;

async function validateCollection(db, name, spec) {
  const collection = db.collection(name);
  const orFields = spec.fields.map((field) => ({ $ne: [{ $type: `$${field}` }, field === 'referralCode' ? 'string' : 'objectId'] }));
  const invalid = await collection.countDocuments({ $expr: { $or: orFields } });
  if (invalid) throw new Error(`Refusing index provisioning: ${invalid} ${name} documents have missing or invalid fields`);

  for (const [field, target] of Object.entries(spec.refs)) {
    const ids = await collection.distinct(field);
    const found = ids.length ? await db.collection(target).distinct('_id', { _id: { $in: ids } }) : [];
    const foundSet = new Set(found.map(String));
    const dangling = ids.filter((id) => !foundSet.has(String(id))).length;
    if (dangling) throw new Error(`Refusing index provisioning: ${dangling} ${name}.${field} references do not exist in ${target}`);
  }

  if (name === COLLECTIONS.AffiliateReferral) {
    const inconsistent = await collection.aggregate([
      { $lookup: { from: 'affiliatepromotions', localField: 'affiliatePromotion', foreignField: '_id', as: 'promotion' } },
      { $unwind: '$promotion' },
      { $match: { $expr: { $or: [{ $ne: ['$affiliate', '$promotion.affiliate'] }, { $ne: ['$product', '$promotion.product'] }] } } },
      { $count: 'count' },
    ]).toArray();
    if (inconsistent[0]?.count) throw new Error(`Refusing index provisioning: ${inconsistent[0].count} affiliate referral records disagree with their promotion ownership/product`);
  }

  for (const index of spec.indexes) {
    const groupKey = Object.fromEntries(Object.keys(index.key).map((field) => [field, `$${field}`]));
    const duplicate = await collection.aggregate([
      { $group: { _id: groupKey, count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } },
      { $count: 'groups' },
    ]).toArray();
    if (duplicate[0]?.groups) throw new Error(`Refusing index provisioning: ${duplicate[0].groups} duplicate key groups for ${index.name}`);
  }
}

async function provisionCollection(db, modelName) {
  const name = COLLECTIONS[modelName];
  const spec = SPEC[modelName];
  let exists = await db.listCollections({ name }, { nameOnly: true }).hasNext();
  let createdCollection = false;
  if (!exists) {
    try { await db.createCollection(name); createdCollection = true; }
    catch (error) { if (error.code !== 48 && error.codeName !== 'NamespaceExists') throw error; }
  }
  const collection = db.collection(name);
  const existing = await collection.listIndexes().toArray();
  for (const required of spec.indexes) {
    const sameName = existing.find((item) => item.name === required.name);
    if (sameName && !hasDefinition(sameName, required)) throw new Error(`Index ${required.name} exists with an incompatible definition; refusing replacement`);
    const sameKey = existing.find((item) => hasSameIndexKey(item, required));
    if (sameKey && !hasDefinition(sameKey, required)) {
      throw new Error(`Index ${sameKey.name} has a conflicting definition for ${required.name}; refusing replacement`);
    }
  }
  await validateCollection(db, name, spec);
  const createdIndexes = [];
  for (const required of spec.indexes) {
    if (existing.some((item) => hasDefinition(item, required))) continue;
    await collection.createIndex(required.key, { unique: true, name: required.name });
    createdIndexes.push(required.name);
  }
  return { collection: name, createdCollection, createdIndexes };
}

async function provisionAffiliateReferralIndexes(db) {
  const product = await provisionCollection(db, 'AffiliateReferral');
  const recruitment = await provisionCollection(db, 'AffiliateRecruitmentReferral');
  return [product, recruitment];
}

async function main() {
  await mongoose.connect(getLocalDevDatabaseUri(), { maxPoolSize: 2 });
  try {
    const result = await provisionAffiliateReferralIndexes(mongoose.connection.db);
    console.log(JSON.stringify({ database: mongoose.connection.db.databaseName, collections: result }, null, 2));
  } finally { await mongoose.disconnect(); }
}

if (require.main === module) {
  main().catch((error) => { console.error(`Referral index provisioning failed: ${error.message}`); process.exitCode = 1; });
}

module.exports = { COLLECTIONS, SPEC, getLocalDevDatabaseUri, hasDefinition, validateCollection, provisionCollection, provisionAffiliateReferralIndexes };
