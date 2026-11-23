const express = require('express');
const Merchant = require('../models/Merchant');
const Vendor = require('../models/Vendor');
const Image = require('../models/Image');
const { protectMerchant } = require('../middleware/protectMerchant');

const DEFINITIONS = {
  store: { model: 'vendor', fields: ['name', 'category', 'productType', 'location', 'address', 'email', 'phone', 'logo', 'banner', 'description', 'visible', 'open'] },
  delivery: { model: 'vendor', fields: ['enabled', 'areas', 'charge', 'estimate', 'pickup', 'processing', 'instructions'] },
  payments: { model: 'vendor', fields: ['methods', 'instructions', 'receivingDetails'] },
  notifications: { model: 'merchant', fields: ['orders', 'orderUpdates', 'messages', 'paymentReminders', 'lowStock', 'announcements'] },
  privacy: { model: 'merchant', fields: ['profileVisible', 'analytics'] },
  policies: { model: 'vendor', fields: ['returns', 'cancellations', 'delivery', 'terms', 'supportEmail'] },
};
const DEFAULTS = {
  store: { name: '', category: '', productType: '', location: '', address: '', email: '', phone: '', logo: '', banner: '', description: '', visible: true, open: true },
  delivery: { enabled: true, areas: [], charge: 0, estimate: '', pickup: false, processing: '', instructions: '' },
  payments: { methods: '', instructions: '', receivingDetails: '' },
  notifications: { orders: true, orderUpdates: true, messages: true, paymentReminders: true, lowStock: false, announcements: true },
  privacy: { profileVisible: true, analytics: false },
  policies: { returns: '', cancellations: '', delivery: '', terms: '', supportEmail: '' },
};
const isPlainObject = (value) => value && typeof value === 'object' && !Array.isArray(value);
const isEmail = (value) => value === '' || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const validImage = (value) => value === '' || (/^https:\/\//i.test(value) && value.length <= 2048) || /^\/api\/images\/[a-zA-Z0-9._-]+$/.test(value);

function normalizeSection(section, input) {
  const definition = DEFINITIONS[section];
  if (!definition || !isPlainObject(input) || Object.keys(input).some((key) => !definition.fields.includes(key))) {
    return { error: 'Invalid settings or unsupported fields' };
  }
  const result = {};
  for (const field of definition.fields) {
    if (!(field in input)) continue;
    let value = input[field];
    if (['enabled', 'pickup', 'visible', 'open', 'orders', 'orderUpdates', 'messages', 'paymentReminders', 'lowStock', 'announcements', 'profileVisible', 'analytics'].includes(field)) {
      if (typeof value !== 'boolean') return { error: `Invalid ${field}` };
    } else if (field === 'charge') {
      value = Number(value);
      if (!Number.isFinite(value) || value < 0 || value > 10000000) return { error: 'Enter a valid delivery charge' };
    } else if (field === 'areas') {
      if (typeof value === 'string') value = value.split(',').map((area) => area.trim()).filter(Boolean);
      if (!Array.isArray(value) || value.length > 100 || value.some((area) => typeof area !== 'string' || area.trim().length > 100)) return { error: 'Invalid delivery areas' };
      value = [...new Set(value.map((area) => area.trim()).filter(Boolean))];
    } else {
      if (typeof value !== 'string') return { error: `Invalid ${field}` };
      value = value.trim();
      const max = field === 'terms' ? 10000 : ['returns', 'cancellations', 'delivery', 'instructions', 'methods', 'receivingDetails'].includes(field) || field === 'description' ? 5000 : 2048;
      if (value.length > max) return { error: `${field} is too long` };
      if (field === 'supportEmail' && !isEmail(value)) return { error: 'Enter a valid support email address' };
      if (['logo', 'banner'].includes(field) && !validImage(value)) return { error: 'Use an HTTPS image URL or an uploaded image reference' };
      if (field === 'email' && !isEmail(value)) return { error: 'Enter a valid contact email address' };
    }
    result[field] = value;
  }
  return { value: result };
}

function vendorSettings(vendor) {
  if (!vendor) return null;
  return {
    store: { ...DEFAULTS.store, name: vendor.name || '', logo: vendor.logo || '', description: vendor.description || '', address: vendor.address || '', email: vendor.contactEmail || '', phone: vendor.contactPhone || '', ...(vendor.settings?.store || {}) },
    delivery: { ...DEFAULTS.delivery, ...(vendor.settings?.delivery || {}) },
    payments: { ...DEFAULTS.payments, ...(vendor.settings?.payments || {}) },
    policies: { ...DEFAULTS.policies, ...(vendor.settings?.policies || {}) },
  };
}

function createMerchantSettingsRouter({ MerchantModel = Merchant, VendorModel = Vendor, ImageModel = Image, protect = protectMerchant } = {}) {
  const router = express.Router();
  router.get('/', protect, async (req, res, next) => {
    try {
      const merchant = await MerchantModel.findById(req.merchant._id).select('settings').lean();
      if (!merchant) return res.status(401).json({ message: 'Merchant not authenticated' });
      const linked = await VendorModel.find({ merchantId: req.merchant._id }).select('name logo description address contactEmail contactPhone settings').lean();
      if (linked.length > 1) return res.status(409).json({ message: 'Multiple stores are associated with this merchant; settings are unavailable pending review' });
      const vendorData = vendorSettings(linked[0]);
      const own = merchant.settings || {};
      const privacy = { ...DEFAULTS.privacy, ...(own.privacy || {}) };
      if (vendorData) privacy.profileVisible = vendorData.store.visible;
      return res.json({ settings: { ...(vendorData || {}), notifications: { ...DEFAULTS.notifications, ...(own.notifications || {}) }, privacy }, storeAvailable: Boolean(linked[0]), staff: { supported: false } });
    } catch (error) { return next(error); }
  });
  router.put('/', protect, async (req, res, next) => {
    try {
      const { section, settings } = req.body || {};
      const definition = DEFINITIONS[section];
      if (!definition) return res.status(400).json({ message: 'Unknown settings section' });
      const normalized = normalizeSection(section, settings);
      if (normalized.error) return res.status(400).json({ message: normalized.error });
      if (definition.model === 'merchant') {
        const updated = await MerchantModel.findByIdAndUpdate(req.merchant._id, { $set: { [`settings.${section}`]: normalized.value } }, { new: true, runValidators: true }).select(`settings.${section}`).lean();
        if (!updated) return res.status(401).json({ message: 'Merchant not authenticated' });
        if (section === 'privacy' && typeof normalized.value.profileVisible === 'boolean') {
          await VendorModel.updateOne({ merchantId: req.merchant._id }, { $set: { 'settings.store.visible': normalized.value.profileVisible } });
        }
        return res.json({ section, settings: { ...DEFAULTS[section], ...(updated.settings?.[section] || {}) } });
      }
      const linked = await VendorModel.find({ merchantId: req.merchant._id }).select('_id').lean();
      if (!linked.length) return res.status(409).json({ message: 'Complete your store application before saving store settings' });
      if (linked.length > 1) return res.status(409).json({ message: 'Multiple stores are associated with this merchant; settings cannot be saved' });
      for (const field of ['logo', 'banner']) {
        const imagePath = normalized.value[field];
        const match = typeof imagePath === 'string' && imagePath.match(/^\/api\/images\/([^/?#]+)$/);
        if (match) {
          const filename = decodeURIComponent(match[1]);
          const ownedImage = await ImageModel.findOne({ filename, ownerType: 'merchant', ownerId: req.merchant._id }).select('_id').lean();
          if (!ownedImage) return res.status(403).json({ message: 'Store images must belong to this merchant account' });
        }
      }
      const fields = {};
      for (const [key, value] of Object.entries(normalized.value)) {
        const path = section === 'store' && ['name', 'logo', 'description', 'address', 'email', 'phone'].includes(key)
          ? ({ name: 'name', logo: 'logo', description: 'description', address: 'address', email: 'contactEmail', phone: 'contactPhone' })[key]
          : `settings.${section}.${key}`;
        fields[path] = value;
      }
      const vendor = await VendorModel.findOneAndUpdate({ _id: linked[0]._id, merchantId: req.merchant._id }, { $set: fields }, { new: true, runValidators: true }).select('name logo description address contactEmail contactPhone settings').lean();
      if (!vendor) return res.status(404).json({ message: 'Associated store not found' });
      if (section === 'store' && typeof normalized.value.visible === 'boolean') {
        await MerchantModel.updateOne({ _id: req.merchant._id }, { $set: { 'settings.privacy.profileVisible': normalized.value.visible } });
      }
      return res.json({ section, settings: vendorSettings(vendor)[section] });
    } catch (error) { return next(error); }
  });
  return router;
}

module.exports = { createMerchantSettingsRouter, normalizeSection, vendorSettings, DEFAULTS };
