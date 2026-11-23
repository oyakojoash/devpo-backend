const express = require('express');
const asyncHandler = require('express-async-handler');
const { protectMerchant } = require('../middleware/protectMerchant');
const subscriptionService = require('../services/merchantSubscriptionService');

function createMerchantSubscriptionRouter({ protect = protectMerchant, service = subscriptionService } = {}) {
  const router = express.Router();
  router.get('/plans', protect, (_req, res) => res.json({ plans: Object.values(service.PLANS) }));
  router.get('/', protect, asyncHandler(async (req, res) => {
    const subscription = await service.getEffectiveSubscription(req.merchant._id);
    return res.json({ subscription });
  }));
  router.post('/upgrade', protect, asyncHandler(async (req, res) => {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) ||
      Object.keys(req.body).some((key) => key !== 'planId') || typeof req.body.planId !== 'string') {
      return res.status(400).json({ message: 'Provide only a valid planId' });
    }
    const result = await service.requestUpgrade(req.merchant._id, req.body.planId);
    return res.status(202).json({ status: 'pending_payment', paymentId: result.payment._id, plan: result.plan, message: result.message });
  }));
  router.post('/renew', protect, asyncHandler(async (req, res) => {
    const result = await service.requestRenewal(req.merchant._id);
    return res.status(202).json({ status: 'pending_payment', paymentId: result.payment._id, plan: result.plan, message: result.message });
  }));
  router.post('/downgrade', protect, asyncHandler(async (req, res) => {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) ||
      Object.keys(req.body).length !== 1 || typeof req.body.planId !== 'string') {
      return res.status(400).json({ message: 'Provide a planId' });
    }
    const subscription = await service.scheduleDowngrade(req.merchant._id, req.body.planId);
    return res.json({ subscription });
  }));
  router.delete('/downgrade', protect, asyncHandler(async (req, res) => {
    const subscription = await service.cancelDowngrade(req.merchant._id);
    return res.json({ subscription });
  }));
  router.post('/cancel-renewal', protect, asyncHandler(async (req, res) => {
    const subscription = await service.cancelRenewal(req.merchant._id);
    return res.json({ subscription, message: 'Renewal cancelled; current paid access continues until expiry.' });
  }));
  return router;
}

module.exports = { createMerchantSubscriptionRouter };
