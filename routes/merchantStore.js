const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const Merchant = require('../models/Merchant');
const Vendor = require('../models/Vendor');
const { protectMerchant } = require('../middleware/protectMerchant');

const ALLOWED_FIELDS = new Set([
  'name', 'logo', 'description', 'businessName', 'contactEmail', 'contactPhone', 'address',
]);
const REQUIRED_FIELDS = ['name', 'logo', 'description'];
const OPTIONAL_FIELDS = ['businessName', 'contactEmail', 'contactPhone', 'address'];
const RESERVATION_LEASE_MS = 2 * 60 * 1000;
const storeApplicationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
});

function validateStoreApplication(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'Invalid store application';
  if (Object.keys(body).some((field) => !ALLOWED_FIELDS.has(field))) return 'Store application contains unsupported fields';
  for (const field of REQUIRED_FIELDS) {
    if (typeof body[field] !== 'string' || !body[field].trim()) return `A valid ${field} is required`;
  }
  for (const field of OPTIONAL_FIELDS) {
    if (body[field] !== undefined && typeof body[field] !== 'string') return `Invalid ${field}`;
  }
  return null;
}

function createMerchantStoreRouter({
  MerchantModel = Merchant,
  VendorModel = Vendor,
  protect = protectMerchant,
  rateLimitMiddleware = storeApplicationLimiter,
  randomUUID = crypto.randomUUID,
  logger = console,
} = {}) {
  const router = express.Router();

  router.post('/', protect, rateLimitMiddleware, async (req, res) => {
    const validationError = validateStoreApplication(req.body);
    if (validationError) return res.status(400).json({ message: validationError });

    const merchantId = req.merchant?._id;
    if (!merchantId) return res.status(401).json({ message: 'Merchant not authenticated' });

    let lockToken;
    let lockAcquired = false;
    try {
      const existingVendors = await VendorModel.find({ merchantId }).select('_id').lean();
      if (existingVendors.length > 0) {
        return res.status(409).json({ message: 'This merchant account already has an associated store' });
      }

      lockToken = randomUUID();
      const now = new Date();
      const reservation = await MerchantModel.findOneAndUpdate(
        {
          _id: merchantId,
          $or: [
            { vendorApplicationReservation: { $exists: false } },
            { 'vendorApplicationReservation.expiresAt': { $lte: now } },
          ],
        },
        { $set: { vendorApplicationReservation: { token: lockToken, expiresAt: new Date(now.getTime() + RESERVATION_LEASE_MS) } } },
        { new: true },
      ).select('_id');
      if (!reservation) {
        return res.status(409).json({ message: 'A store application is already in progress for this merchant' });
      }
      lockAcquired = true;

      // Recheck after acquiring the per-Merchant atomic reservation. This also
      // catches a link written by another authorized process during the first read.
      const linkedVendor = await VendorModel.find({ merchantId }).select('_id').lean();
      if (linkedVendor.length > 0) {
        return res.status(409).json({ message: 'This merchant account already has an associated store' });
      }

      const application = {
        // Vendor.id is already unique. A stable merchant-specific value makes
        // retries after a successful insert safe even if cleanup or the HTTP
        // response failed, and closes the expired-lease overlap race.
        id: `merchant-store-${merchantId}`,
        merchantId,
        name: req.body.name.trim(),
        logo: req.body.logo.trim(),
        description: req.body.description.trim(),
        approvalStatus: 'pending',
        status: 'suspended',
      };
      const merchantPreferences = await MerchantModel.findById(merchantId).select('settings.privacy.profileVisible').lean();
      if (merchantPreferences?.settings?.privacy?.profileVisible === false) {
        application.settings = { store: { visible: false } };
      }
      for (const field of OPTIONAL_FIELDS) {
        if (req.body[field] !== undefined) application[field] = req.body[field].trim();
      }

      const vendor = await VendorModel.create(application);
      return res.status(201).json({
        message: 'Store application submitted',
        vendor: {
          id: vendor.id,
          name: vendor.name,
          logo: vendor.logo,
          description: vendor.description,
          approvalStatus: vendor.approvalStatus,
          status: vendor.status,
        },
      });
    } catch (error) {
      logger.error('Merchant store application failed', { name: error?.name || 'Error', code: error?.code || 'UNSPECIFIED' });
      return res.status(500).json({ message: 'Failed to submit store application' });
    } finally {
      if (lockAcquired) {
        try {
          await MerchantModel.updateOne(
            { _id: merchantId, 'vendorApplicationReservation.token': lockToken },
            { $unset: { vendorApplicationReservation: 1 } },
          );
        } catch (error) {
          // A saved Vendor still blocks a second application; this log signals
          // that an orphaned reservation needs operational attention.
          logger.error('Merchant store application lock release failed', {
            name: error?.name || 'Error', code: error?.code || 'UNSPECIFIED',
          });
        }
      }
    }
  });

  return router;
}

module.exports = { createMerchantStoreRouter, validateStoreApplication };
