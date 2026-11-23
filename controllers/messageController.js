const mongoose = require('mongoose');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const Merchant = require('../models/Merchant');
const Affiliate = require('../models/Affiliate');
const User = require('../models/User');

const objectIdPattern = /^[a-f\d]{24}$/i;
const clientMessageIdPattern = /^[A-Za-z0-9_-]{8,128}$/;
const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 30;

const idString = (value) => String(value?._id ?? value ?? '');
const isValidId = (value) => typeof value === 'string' && objectIdPattern.test(value);
const actorFor = (req) => {
  if (req.affiliate) return { type: 'affiliate', id: idString(req.affiliate._id) };
  if (req.merchant) return { type: 'merchant', id: idString(req.merchant._id) };
  return { type: 'customer', id: idString(req.user?._id) };
};
const memberQuery = (conversationId, actor) => ({
  _id: conversationId,
  ...(actor.type === 'customer' ? { customerId: actor.id }
    : actor.type === 'merchant' ? { merchantId: actor.id } : { affiliateId: actor.id }),
});
const unreadField = (actor) => actor.type === 'customer' ? 'customerUnreadCount'
  : actor.type === 'merchant' ? 'merchantUnreadCount' : 'affiliateUnreadCount';

function serializeConversation(doc) {
  const value = doc?.toObject ? doc.toObject() : doc;
  const result = {
    id: idString(value._id ?? value.id),
    customerId: idString(value.customerId),
    merchantId: idString(value.merchantId),
    lastMessage: value.lastMessage || '',
    lastMessageAt: value.lastMessageAt || null,
    customerUnreadCount: value.customerUnreadCount || 0,
    merchantUnreadCount: value.merchantUnreadCount || 0,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
  if (value.affiliateId) {
    result.affiliateId = idString(value.affiliateId);
    result.affiliateUnreadCount = value.affiliateUnreadCount || 0;
    result.recipientType = 'affiliate';
  }
  return result;
}

function serializeMessage(doc) {
  const value = doc?.toObject ? doc.toObject() : doc;
  return {
    id: idString(value._id ?? value.id),
    conversationId: idString(value.conversationId),
    senderId: idString(value.senderId),
    senderType: value.senderType,
    clientMessageId: value.clientMessageId,
    text: value.text,
    readAt: value.readAt || null,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

const errorResponse = (res, status, message) => res.status(status).json({ message });

function isTransactionUnavailable(error) {
  return error?.code === 20
    || error?.codeName === 'IllegalOperation'
    || /transactions are not supported|transaction numbers are only allowed/i.test(error?.message || '');
}

function createMessageController({
  ConversationModel = Conversation,
  MessageModel = Message,
  MerchantModel = Merchant,
  AffiliateModel = Affiliate,
  CustomerModel = User,
  startSession = () => mongoose.startSession(),
  now = () => new Date(),
} = {}) {
  async function withTransaction(work) {
    const session = await startSession();
    try {
      return await session.withTransaction(() => work(session));
    } finally {
      await session.endSession();
    }
  }

  async function createOrGetConversation(req, res) {
    const isAffiliate = Boolean(req.affiliate);
    const merchantId = req.body?.merchantId;
    const affiliateId = req.body?.affiliateId;
    const customerId = req.body?.customerId;
    if (isAffiliate) {
      if (merchantId !== undefined || affiliateId !== undefined) return errorResponse(res, 400, 'Affiliates must provide customerId only');
      if (!isValidId(customerId)) return errorResponse(res, 400, 'Invalid Customer ID');
    } else if ((merchantId === undefined) === (affiliateId === undefined) || customerId !== undefined) {
      return errorResponse(res, 400, 'Provide exactly one of merchantId or affiliateId');
    }
    const recipientType = isAffiliate ? 'customer' : merchantId !== undefined ? 'merchant' : 'affiliate';
    const recipientId = isAffiliate ? customerId : merchantId ?? affiliateId;
    if (!isValidId(recipientId)) return errorResponse(res, 400, `Invalid ${recipientType} ID`);
    try {
      const recipient = recipientType === 'merchant'
        ? await MerchantModel.findById(recipientId).select('_id').lean()
        : recipientType === 'affiliate'
          ? await AffiliateModel.findById(recipientId).select('_id status').lean()
          : await CustomerModel.findById(recipientId).select('_id role isAdmin').lean();
      if (!recipient || (recipientType === 'affiliate' && recipient.status !== 'active')
        || (recipientType === 'customer' && (recipient.role !== 'user' || recipient.isAdmin === true))) {
        return errorResponse(res, 404, `${recipientType === 'merchant' ? 'Merchant' : recipientType === 'affiliate' ? 'Affiliate' : 'Customer'} not found`);
      }
      const filter = isAffiliate
        ? { customerId: recipient._id, affiliateId: req.affiliate._id }
        : { customerId: req.user._id, [`${recipientType}Id`]: recipient._id };
      try {
        const conversation = await ConversationModel.findOneAndUpdate(
          filter,
          { $setOnInsert: {
            ...filter, lastMessage: '', lastMessageAt: null,
            customerUnreadCount: 0, merchantUnreadCount: 0, affiliateUnreadCount: 0,
          } },
          { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true },
        );
        return res.status(200).json({ conversation: serializeConversation(conversation) });
      } catch (error) {
        if (error?.code !== 11000) throw error;
        const existing = await ConversationModel.findOne(filter).lean();
        if (!existing) throw error;
        return res.status(200).json({ conversation: serializeConversation(existing) });
      }
    } catch (_error) {
      return errorResponse(res, 500, 'Failed to create conversation');
    }
  }

  async function listConversations(req, res) {
    const actor = actorFor(req);
    const filter = actor.type === 'customer'
      ? { customerId: new mongoose.Types.ObjectId(actor.id) }
      : actor.type === 'merchant'
        ? { merchantId: new mongoose.Types.ObjectId(actor.id) }
        : { affiliateId: new mongoose.Types.ObjectId(actor.id) };
    const rawLimit = req.query.limit === undefined ? DEFAULT_PAGE_SIZE : Number(req.query.limit);
    if (!Number.isInteger(rawLimit) || rawLimit < 1) return errorResponse(res, 400, 'Invalid page size');
    const limit = Math.min(rawLimit, MAX_PAGE_SIZE);
    let cursor;
    if (req.query.before !== undefined) {
      try {
        const decoded = JSON.parse(Buffer.from(String(req.query.before), 'base64url').toString('utf8'));
        if (!isValidId(decoded.id) || typeof decoded.updatedAt !== 'string' || !Number.isFinite(Date.parse(decoded.updatedAt))) throw new Error('invalid cursor');
        cursor = { id: decoded.id, updatedAt: new Date(decoded.updatedAt) };
      } catch (_error) {
        return errorResponse(res, 400, 'Invalid pagination cursor');
      }
    }
    if (cursor) filter.$or = [
      { updatedAt: { $lt: cursor.updatedAt } },
      { updatedAt: cursor.updatedAt, _id: { $lt: new mongoose.Types.ObjectId(cursor.id) } },
    ];
    try {
      const rows = await ConversationModel.find(filter).sort({ updatedAt: -1, _id: -1 }).limit(limit + 1).lean();
      const hasMore = rows.length > limit;
      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      const nextCursor = hasMore && last
        ? Buffer.from(JSON.stringify({ id: idString(last._id), updatedAt: new Date(last.updatedAt).toISOString() })).toString('base64url')
        : null;
      return res.json({ conversations: page.map(serializeConversation), pageSize: limit, hasMore, nextCursor });
    } catch (_error) {
      return errorResponse(res, 500, 'Failed to fetch conversations');
    }
  }

  async function getConversation(req, res) {
    if (!isValidId(req.params.conversationId)) return errorResponse(res, 400, 'Invalid conversation ID');
    try {
      const conversation = await ConversationModel.findOne(memberQuery(req.params.conversationId, actorFor(req))).lean();
      if (!conversation) return errorResponse(res, 404, 'Conversation not found');
      return res.json({ conversation: serializeConversation(conversation) });
    } catch (_error) {
      return errorResponse(res, 500, 'Failed to fetch conversation');
    }
  }

  async function listMessages(req, res) {
    if (!isValidId(req.params.conversationId)) return errorResponse(res, 400, 'Invalid conversation ID');
    const rawLimit = req.query.limit === undefined ? DEFAULT_PAGE_SIZE : Number(req.query.limit);
    if (!Number.isInteger(rawLimit) || rawLimit < 1) return errorResponse(res, 400, 'Invalid page size');
    const limit = Math.min(rawLimit, MAX_PAGE_SIZE);
    let cursor;
    if (req.query.before !== undefined) {
      try {
        const decoded = JSON.parse(Buffer.from(String(req.query.before), 'base64url').toString('utf8'));
        if (!isValidId(decoded.id) || typeof decoded.createdAt !== 'string' || !Number.isFinite(Date.parse(decoded.createdAt))) throw new Error('invalid cursor');
        cursor = { id: decoded.id, createdAt: new Date(decoded.createdAt) };
      } catch (_error) {
        return errorResponse(res, 400, 'Invalid pagination cursor');
      }
    }
    try {
      const conversation = await ConversationModel.findOne(memberQuery(req.params.conversationId, actorFor(req))).select('_id').lean();
      if (!conversation) return errorResponse(res, 404, 'Conversation not found');
      const filter = { conversationId: conversation._id };
      if (cursor) filter.$or = [
        { createdAt: { $lt: cursor.createdAt } },
        { createdAt: cursor.createdAt, _id: { $lt: new mongoose.Types.ObjectId(cursor.id) } },
      ];
      const rows = await MessageModel.find(filter).sort({ createdAt: -1, _id: -1 }).limit(limit + 1).lean();
      const hasMore = rows.length > limit;
      const page = rows.slice(0, limit).reverse();
      const first = page[0];
      const nextCursor = hasMore && first
        ? Buffer.from(JSON.stringify({ id: idString(first._id), createdAt: new Date(first.createdAt).toISOString() })).toString('base64url')
        : null;
      return res.json({ messages: page.map(serializeMessage), pageSize: limit, hasMore, nextCursor });
    } catch (_error) {
      return errorResponse(res, 500, 'Failed to fetch messages');
    }
  }

  async function findIdempotentMessage(identity) {
    return MessageModel.findOne(identity).lean();
  }

  async function sendMessage(req, res) {
    if (!isValidId(req.params.conversationId)) return errorResponse(res, 400, 'Invalid conversation ID');
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    if (!text || text.length > MessageModel.MAX_MESSAGE_LENGTH) {
      return errorResponse(res, 400, `Message must contain 1 to ${MessageModel.MAX_MESSAGE_LENGTH} characters`);
    }
    const clientMessageId = req.body?.clientMessageId;
    if (typeof clientMessageId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(clientMessageId)) {
      return errorResponse(res, 400, 'clientMessageId must be 8 to 128 letters, digits, underscores, or hyphens');
    }
    const actor = actorFor(req);
    const identity = {
      conversationId: new mongoose.Types.ObjectId(req.params.conversationId),
      senderType: actor.type,
      senderId: new mongoose.Types.ObjectId(actor.id),
      clientMessageId,
    };
    let transactionResult;
    try {
      transactionResult = await withTransaction(async (session) => {
        const conversation = await ConversationModel.findOne(memberQuery(identity.conversationId, actor))
          .select('_id merchantId affiliateId').session(session).lean();
        if (!conversation) return { status: 404, error: 'Conversation not found' };

        const previous = await MessageModel.findOne(identity).session(session).lean();
        if (previous) return { status: 200, message: previous, replay: true };

        const createdAt = now();
        const [message] = await MessageModel.create([{
          ...identity,
          text,
          readAt: null,
          createdAt,
          updatedAt: createdAt,
        }], { session });
        const recipientUnreadField = actor.type === 'customer'
          ? (conversation.affiliateId ? 'affiliateUnreadCount' : 'merchantUnreadCount')
          : 'customerUnreadCount';
        const update = await ConversationModel.updateOne({ _id: conversation._id }, [{ $set: {
          lastMessage: { $cond: [{ $gte: [createdAt, { $ifNull: ['$lastMessageAt', new Date(0)] }] }, message.text, '$lastMessage'] },
          lastMessageAt: { $max: [{ $ifNull: ['$lastMessageAt', new Date(0)] }, createdAt] },
          updatedAt: { $max: [{ $ifNull: ['$updatedAt', createdAt] }, createdAt] },
          [recipientUnreadField]: { $add: [{ $ifNull: [`$${recipientUnreadField}`, 0] }, 1] },
        } }], { session });
        if (update.matchedCount === 0) throw new Error('Conversation disappeared during message send');
        return { status: 201, message, replay: false };
      });
    } catch (error) {
      if (error?.code === 11000) {
        try {
          const existing = await findIdempotentMessage(identity);
          if (existing) return res.status(200).json({ message: serializeMessage(existing), idempotentReplay: true });
        } catch (_lookupError) { /* fall through to a safe response */ }
      }
      if (isTransactionUnavailable(error)) return errorResponse(res, 503, 'Messaging writes require MongoDB replica set or sharded-cluster transaction support');
      return errorResponse(res, 500, 'Failed to send message');
    }
    if (transactionResult?.error) return errorResponse(res, transactionResult.status, transactionResult.error);
    if (!transactionResult?.message) return errorResponse(res, 500, 'Failed to send message');
    return res.status(transactionResult.status).json({ message: serializeMessage(transactionResult.message), idempotentReplay: transactionResult.replay });
  }

  async function markRead(req, res) {
    if (!isValidId(req.params.conversationId)) return errorResponse(res, 400, 'Invalid conversation ID');
    const actor = actorFor(req);
    try {
      const result = await withTransaction(async (session) => {
        const conversation = await ConversationModel.findOne(memberQuery(req.params.conversationId, actor))
          .select('_id affiliateId').session(session).lean();
        if (!conversation) return { status: 404, error: 'Conversation not found' };
        const senderType = actor.type === 'customer'
          ? (conversation.affiliateId ? 'affiliate' : 'merchant')
          : 'customer';
        const incomingFilter = { conversationId: conversation._id, senderType, readAt: null };
        const transitioned = await MessageModel.updateMany(incomingFilter, { $set: { readAt: now() } }, { session });
        const remainingUnread = await MessageModel.countDocuments({ conversationId: conversation._id, senderType, readAt: null }).session(session);
        const counterUpdate = await ConversationModel.updateOne(
          { _id: conversation._id },
          [{ $set: { [unreadField(actor)]: remainingUnread } }],
          { session },
        );
        if (counterUpdate.matchedCount === 0) throw new Error('Conversation disappeared while marking messages read');
        return { markedRead: transitioned.modifiedCount ?? transitioned.nModified ?? 0 };
      });
      if (result?.error) return errorResponse(res, result.status, result.error);
      return res.json({ markedRead: result.markedRead });
    } catch (error) {
      if (isTransactionUnavailable(error)) return errorResponse(res, 503, 'Messaging writes require MongoDB replica set or sharded-cluster transaction support');
      return errorResponse(res, 500, 'Failed to mark messages as read');
    }
  }

  async function unreadCount(req, res) {
    const actor = actorFor(req);
    const field = unreadField(actor);
    const filter = actor.type === 'customer'
      ? { customerId: new mongoose.Types.ObjectId(actor.id) }
      : actor.type === 'merchant'
        ? { merchantId: new mongoose.Types.ObjectId(actor.id) }
        : { affiliateId: new mongoose.Types.ObjectId(actor.id) };
    try {
      const [result] = await ConversationModel.aggregate([
        { $match: filter },
        { $group: { _id: null, total: { $sum: `$${field}` } } },
      ]);
      return res.json({ unreadCount: result?.total || 0 });
    } catch (_error) {
      return errorResponse(res, 500, 'Failed to fetch unread count');
    }
  }

  return { createOrGetConversation, listConversations, getConversation, listMessages, sendMessage, markRead, unreadCount };
}

module.exports = { createMessageController, isValidId, MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE, isTransactionUnavailable };
