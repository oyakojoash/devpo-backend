const emailService = require('./emailService');
const Merchant = require('../models/Merchant');
const User = require('../models/User');

async function sendEmail(to, subject, message) {
  if (!to) return;
  try { await emailService.sendOrderNotificationEmail(to, subject, message); }
  catch (error) {
    // Order state remains authoritative if email configuration or delivery is unavailable.
    console.warn('Order notification email was not delivered:', error.name || 'Error');
  }
}

async function notifyMerchants(order, subject, message) {
  try {
    await Promise.all((order.merchantGroups || []).map(async (group) => {
      const merchant = await Merchant.findById(group.merchant).select('email').lean();
      return sendEmail(merchant?.email, subject, message);
    }));
  } catch (error) { console.warn('Merchant order notification lookup failed:', error.name || 'Error'); }
}

async function notifyVendors(order, subject, message) {
  const Vendor = require('../models/Vendor');
  try {
    await Promise.all((order.vendorGroups || []).map(async (group) => {
      const vendor = await Vendor.findOne({ id: group.vendorId }).select('contactEmail').lean();
      return sendEmail(vendor?.contactEmail, subject, message);
    }));
  } catch (error) { console.warn('Vendor order notification lookup failed:', error.name || 'Error'); }
}

async function notifyCustomer(order, subject, message) {
  try {
    const user = order.userInfo?.email ? null : await User.findById(order.user).select('email').lean();
    return await sendEmail(order.userInfo?.email || user?.email, subject, message);
  } catch (error) { console.warn('Customer order notification lookup failed:', error.name || 'Error'); }
}

module.exports = { sendEmail, notifyMerchants, notifyVendors, notifyCustomer };
