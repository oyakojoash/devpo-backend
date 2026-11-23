const express = require('express');
const { protect } = require('../middleware/auth');
const { protectMerchant } = require('../middleware/protectMerchant');
const { protectAffiliate } = require('../middleware/protectAffiliate');
const { createMessageController } = require('../controllers/messageController');

function createMessagesRouter({
  customerAuth = protect,
  merchantAuth = protectMerchant,
  affiliateAuth = protectAffiliate,
  controller = createMessageController(),
} = {}) {
  const router = express.Router();

  const authenticateEither = (req, res, next) => {
    const hasCustomerToken = Boolean(req.cookies?.token);
    const hasMerchantToken = Boolean(req.cookies?.merchantToken);
    const hasAffiliateToken = Boolean(req.cookies?.affiliateToken);
    const requestedType = req.headers?.['x-messaging-account-type'];
    if (requestedType !== undefined && !['customer', 'merchant', 'affiliate'].includes(requestedType)) {
      return res.status(400).json({ message: 'Invalid messaging account type' });
    }
    if (requestedType === 'customer' || (!requestedType && hasCustomerToken && !hasMerchantToken && !hasAffiliateToken)) {
      if (!hasCustomerToken) return res.status(401).json({ message: 'Not authorized' });
      return customerAuth(req, res, (error) => {
        if (error) return next(error);
        if (req.user?.role === 'admin' || req.user?.isAdmin === true) return res.status(403).json({ message: 'Messaging is available to Customers, Merchants, and Affiliates only' });
        return next();
      });
    }
    if (requestedType === 'merchant' || (!requestedType && hasMerchantToken && !hasCustomerToken && !hasAffiliateToken)) {
      if (!hasMerchantToken) return res.status(401).json({ message: 'Merchant not authenticated' });
      return merchantAuth(req, res, next);
    }
    if (requestedType === 'affiliate' || (!requestedType && hasAffiliateToken && !hasCustomerToken && !hasMerchantToken)) {
      if (!hasAffiliateToken) return res.status(401).json({ message: 'Affiliate not authenticated' });
      return affiliateAuth(req, res, next);
    }
    if (!requestedType && [hasCustomerToken, hasMerchantToken, hasAffiliateToken].filter(Boolean).length > 1) {
      return res.status(400).json({ message: 'Select a messaging account type' });
    }
    return res.status(401).json({ message: 'Not authorized' });
  };

  router.post('/conversations', authenticateEither, (req, res, next) => {
    if (req.merchant) return res.status(403).json({ message: 'Merchants cannot start a conversation' });
    if (req.user?.role === 'admin' || req.user?.isAdmin === true) return res.status(403).json({ message: 'Admins cannot start a conversation' });
    return controller.createOrGetConversation(req, res, next);
  });
  router.get('/conversations', authenticateEither, controller.listConversations);
  router.get('/conversations/:conversationId', authenticateEither, controller.getConversation);
  router.get('/conversations/:conversationId/messages', authenticateEither, controller.listMessages);
  router.post('/conversations/:conversationId/messages', authenticateEither, controller.sendMessage);
  router.patch('/conversations/:conversationId/read', authenticateEither, controller.markRead);
  router.get('/unread-count', authenticateEither, controller.unreadCount);

  return router;
}

module.exports = createMessagesRouter;
