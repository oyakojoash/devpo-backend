require('dotenv').config();

const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const Merchant = require('../models/Merchant');
const MerchantProduct = require('../models/MerchantProduct');
const Product = require('../models/Product');
const Vendor = require('../models/Vendor');

const RETAIL_PRODUCT_IDS = [
  '6ae25d6e67672ae39407f747',
  '6ae25e8567672ae39407f74b',
];
const LEGACY_PRODUCT_ID = new mongoose.Types.ObjectId('6f0000000000000000000001');
const LEGACY_VENDOR_ID = 'dvepo-local-fixture-legacy-vendor-v1';
const IMAGE_REFERENCE = '/images/fallback.png';

function assertLocalDatabaseTarget(uri) {
  if (!uri) throw new Error('MONGO_URI is not configured');

  let target;
  try {
    target = new URL(uri);
  } catch (_error) {
    throw new Error('Refusing to run: MONGO_URI is not a valid MongoDB URI');
  }

  const databaseName = decodeURIComponent(target.pathname.replace(/^\//, ''));
  if (target.protocol !== 'mongodb:' || target.hostname !== 'localhost' ||
      target.port !== '27017' || databaseName !== 'devpo') {
    throw new Error('Refusing to run: only mongodb://localhost:27017/devpo is allowed');
  }
}

function exactFields(record, expected) {
  return Object.entries(expected).every(([key, value]) => {
    const actual = record[key];
    if (key === 'merchantId' || key === '_id') return String(actual) === String(value);
    return actual === value;
  });
}

function assertExpectedFixture(record, expected, label) {
  assert(record, `${label} fixture was not found after creation`);
  assert(exactFields(record, expected), `${label} fixture identifier already exists with different data; refusing to modify it`);
}

async function ensureVendor(expected) {
  let vendor = await Vendor.findOne({ id: expected.id }).lean();
  if (vendor) {
    assertExpectedFixture(vendor, expected, `Vendor ${expected.id}`);
    return { vendor, created: false };
  }

  try {
    vendor = await Vendor.create(expected);
    return { vendor: vendor.toObject(), created: true };
  } catch (error) {
    if (error?.code !== 11000) throw error;
    vendor = await Vendor.findOne({ id: expected.id }).lean();
    assertExpectedFixture(vendor, expected, `Vendor ${expected.id}`);
    return { vendor, created: false };
  }
}

async function ensureLegacyProduct(expected) {
  let product = await Product.findById(expected._id).lean();
  if (product) {
    assertExpectedFixture(product, expected, 'Legacy Product');
    return { product, created: false };
  }

  try {
    product = await Product.create(expected);
    return { product: product.toObject(), created: true };
  } catch (error) {
    if (error?.code !== 11000) throw error;
    product = await Product.findById(expected._id).lean();
    assertExpectedFixture(product, expected, 'Legacy Product');
    return { product, created: false };
  }
}

async function main() {
  const uri = process.env.MONGO_URI;
  assertLocalDatabaseTarget(uri);

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000, maxPoolSize: 2 });
  assert.equal(mongoose.connection.host, 'localhost', 'Connected host must be localhost');
  assert.equal(mongoose.connection.port, 27017, 'Connected port must be 27017');
  assert.equal(mongoose.connection.name, 'devpo', 'Connected database must be devpo');

  const originalRetailProducts = await MerchantProduct.find({
    _id: { $in: RETAIL_PRODUCT_IDS },
  }).sort({ _id: 1 }).lean();
  assert.equal(originalRetailProducts.length, RETAIL_PRODUCT_IDS.length,
    'Expected local retail MerchantProducts were not all found; refusing to create fixtures');
  assert(originalRetailProducts.every((product) => product.model === 'retail'),
    'A targeted MerchantProduct is not retail; refusing to continue');
  assert(originalRetailProducts.every((product) => product.status === 'active' &&
    product.archivedAt === null && Number.isFinite(product.retail?.price) &&
    product.retail.price > 0 && Number.isSafeInteger(product.retail?.stock) &&
    product.retail.stock > 0),
  'A targeted MerchantProduct is not currently eligible; refusing to continue');

  const merchantIds = [...new Set(originalRetailProducts.map((product) => String(product.merchant)))];
  assert.equal(merchantIds.length, 1,
    'The targeted retail products do not share the verified Merchant; refusing to link stores');
  const merchantId = new mongoose.Types.ObjectId(merchantIds[0]);
  assert(await Merchant.exists({ _id: merchantId }),
    'The Merchant owner does not exist; refusing to modify MerchantProduct ownership');

  const linkedVendors = await Vendor.find({ merchantId })
    .select('_id id name logo description merchantId approvalStatus status').lean();
  assert(linkedVendors.length <= 1,
    'Merchant already has multiple linked Vendors; refusing to create another');

  const merchantVendorExpected = {
    id: `dvepo-local-fixture-merchant-store-${merchantId}`,
    name: 'Dvepo Local Merchant Fixture Store',
    logo: IMAGE_REFERENCE,
    description: 'Synthetic local-only store for unified catalogue testing.',
    merchantId,
    approvalStatus: 'approved',
    status: 'active',
  };
  if (linkedVendors.length === 1) {
    const existing = linkedVendors[0];
    assert(existing.approvalStatus === 'approved' && existing.status === 'active',
      'The Merchant already has one ineligible Vendor; refusing to alter it or create a duplicate');
    // An existing eligible Vendor is reused as-is, regardless of who created it.
  }

  const legacyVendorExpected = {
    id: LEGACY_VENDOR_ID,
    name: 'Dvepo Local Legacy Fixture Store',
    logo: IMAGE_REFERENCE,
    description: 'Synthetic local-only Vendor for legacy catalogue testing.',
    approvalStatus: 'approved',
    status: 'active',
  };
  const existingLegacyVendor = await Vendor.findOne({ id: LEGACY_VENDOR_ID }).lean();
  if (existingLegacyVendor) {
    assertExpectedFixture(existingLegacyVendor, legacyVendorExpected, 'Legacy Vendor');
  }

  const legacyProductExpected = {
    _id: LEGACY_PRODUCT_ID,
    name: 'Dvepo Local Legacy Fixture Product',
    price: 1500,
    image: IMAGE_REFERENCE,
    vendorId: LEGACY_VENDOR_ID,
    description: 'Synthetic local-only Product for unified catalogue testing.',
  };
  const existingLegacyProduct = await Product.findById(LEGACY_PRODUCT_ID).lean();
  if (existingLegacyProduct) {
    assertExpectedFixture(existingLegacyProduct, legacyProductExpected, 'Legacy Product');
  }

  const countsCreated = { Vendor: 0, Product: 0 };
  if (linkedVendors.length === 0) {
    const result = await ensureVendor(merchantVendorExpected);
    if (result.created) countsCreated.Vendor += 1;
  }
  const legacyVendorResult = await ensureVendor(legacyVendorExpected);
  if (legacyVendorResult.created) countsCreated.Vendor += 1;
  const legacyProductResult = await ensureLegacyProduct(legacyProductExpected);
  if (legacyProductResult.created) countsCreated.Product += 1;

  const finalLinkedVendors = await Vendor.find({ merchantId })
    .select('_id id merchantId approvalStatus status').lean();
  assert.equal(finalLinkedVendors.length, 1, 'Merchant must have exactly one linked Vendor');
  assert.equal(finalLinkedVendors[0].approvalStatus, 'approved');
  assert.equal(finalLinkedVendors[0].status, 'active');
  assert.equal(String(finalLinkedVendors[0].merchantId), String(merchantId));

  const finalLegacyVendor = await Vendor.findOne({ id: LEGACY_VENDOR_ID }).lean();
  assertExpectedFixture(finalLegacyVendor, legacyVendorExpected, 'Legacy Vendor');
  const finalLegacyProduct = await Product.findById(LEGACY_PRODUCT_ID).lean();
  assertExpectedFixture(finalLegacyProduct, legacyProductExpected, 'Legacy Product');

  const unchangedRetailProducts = await MerchantProduct.find({
    _id: { $in: RETAIL_PRODUCT_IDS },
  }).sort({ _id: 1 }).lean();
  assert.deepStrictEqual(unchangedRetailProducts, originalRetailProducts,
    'Existing retail MerchantProducts changed during fixture creation');

  const counts = {
    Product: await Product.countDocuments({}),
    Vendor: await Vendor.countDocuments({}),
    MerchantProduct: await MerchantProduct.countDocuments({}),
  };
  console.log(JSON.stringify({
    database: `${mongoose.connection.host}:${mongoose.connection.port}/${mongoose.connection.name}`,
    created: countsCreated,
    reused: { merchantLinkedVendor: linkedVendors.length === 1, legacyVendor: !legacyVendorResult.created, legacyProduct: !legacyProductResult.created },
    fixtureIds: {
      merchantVendorId: finalLinkedVendors[0].id,
      legacyVendorId: finalLegacyVendor.id,
      legacyProductId: String(finalLegacyProduct._id),
    },
    merchantProductsUnchanged: true,
    linkedMerchantVendorCount: finalLinkedVendors.length,
    counts,
  }, null, 2));
}

main()
  .catch((error) => {
    console.error(`Local catalogue fixture stopped safely: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => {});
  });
