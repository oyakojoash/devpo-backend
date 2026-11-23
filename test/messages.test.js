const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { createMessageController } = require('../controllers/messageController');
const createMessagesRouter = require('../routes/messages');
const { ensureMessagingIndexes, CONVERSATION_INDEXES, MESSAGE_INDEXES } = require('../utils/messagingIndexReadiness');
const ConversationModel = require('../models/Conversation');
const MessageModel = require('../models/Message');

const customerA = new mongoose.Types.ObjectId();
const customerB = new mongoose.Types.ObjectId();
const merchantA = new mongoose.Types.ObjectId();
const merchantB = new mongoose.Types.ObjectId();
const affiliateA = new mongoose.Types.ObjectId();
const affiliateB = new mongoose.Types.ObjectId();
const inactiveAffiliate = new mongoose.Types.ObjectId();
const adminA = new mongoose.Types.ObjectId();

function makeStore() {
  const conversations = [];
  const messages = [];
  let transactionQueue = Promise.resolve();
  const sameId = (a, b) => String(a) === String(b);
  const match = (row, filter) => Object.entries(filter).every(([key, value]) => {
    if (key === '$or') return value.some((part) => match(row, part));
    if (key === 'createdAt' && value && typeof value === 'object') {
      if (value.$lt) return new Date(row.createdAt) < value.$lt;
    }
    if (key === 'updatedAt' && value && typeof value === 'object' && value.$lt) return new Date(row.updatedAt) < value.$lt;
    if (key === '_id' && value && typeof value === 'object' && value.$lt) return String(row._id) < String(value.$lt);
    return sameId(row[key], value);
  });
  const query = (resolver) => ({
    sort(spec) { this.spec = spec; return this; }, limit(n) { this.n = n; return this; }, select() { return this; }, session() { return this; },
    async lean() {
      let value = await resolver();
      if (Array.isArray(value) && this.spec) value = value.slice().sort((a, b) => {
        for (const [field, direction] of Object.entries(this.spec)) {
          const left = a[field]; const right = b[field];
          const compared = left instanceof Date && right instanceof Date ? left - right : String(left).localeCompare(String(right));
          if (compared) return compared * direction;
        }
        return 0;
      });
      return Array.isArray(value) && this.n ? value.slice(0, this.n) : value;
    },
  });
  const countQuery = (resolver) => ({ session() { return this; }, then(resolve, reject) { return Promise.resolve().then(resolver).then(resolve, reject); } });
  const evaluate = (expr, row) => {
    if (typeof expr === 'string' && expr.startsWith('$')) return row[expr.slice(1)];
    if (Array.isArray(expr)) return expr.map((item) => evaluate(item, row));
    if (!expr || typeof expr !== 'object' || expr instanceof Date || expr instanceof mongoose.Types.ObjectId) return expr;
    if ('$ifNull' in expr) { const [v, fallback] = expr.$ifNull; return evaluate(v, row) ?? evaluate(fallback, row); }
    if ('$add' in expr) return expr.$add.map((v) => evaluate(v, row)).reduce((a, b) => a + b, 0);
    if ('$max' in expr) return expr.$max.map((v) => evaluate(v, row)).reduce((a, b) => a > b ? a : b);
    if ('$subtract' in expr) { const [a, b] = expr.$subtract.map((v) => evaluate(v, row)); return a - b; }
    if ('$gte' in expr) { const [a, b] = expr.$gte.map((v) => evaluate(v, row)); return a >= b; }
    if ('$cond' in expr) { const [condition, yes, no] = expr.$cond; return evaluate(condition, row) ? evaluate(yes, row) : evaluate(no, row); }
    return Object.fromEntries(Object.entries(expr).map(([key, value]) => [key, evaluate(value, row)]));
  };
  const Conversation = {
    async findOneAndUpdate(filter, update) {
      let row = conversations.find((item) => match(item, filter));
      if (!row) { row = { _id: new mongoose.Types.ObjectId(), ...update.$setOnInsert, createdAt: new Date(), updatedAt: new Date() }; conversations.push(row); }
      return row;
    },
    findOne(filter) { return query(async () => conversations.find((row) => match(row, filter)) || null); },
    find(filter) { return query(async () => conversations.filter((row) => match(row, filter))); },
    async updateOne(filter, stages) {
      const row = conversations.find((item) => match(item, filter));
      if (!row) return { matchedCount: 0 };
      const set = stages[0].$set;
      for (const [key, expression] of Object.entries(set)) row[key] = evaluate(expression, row);
      return { matchedCount: 1 };
    },
  };
  const Message = {
    MAX_MESSAGE_LENGTH: 2000,
    findOne(filter) { return query(async () => messages.find((row) => match(row, filter)) || null); },
    async create(rows) { return rows.map((data) => { const row = { _id: new mongoose.Types.ObjectId(), ...data }; messages.push(row); return row; }); },
    find(filter) {
      const sorted = () => messages.filter((row) => match(row, filter)).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt) || String(b._id).localeCompare(String(a._id)));
      return query(async () => sorted());
    },
    async deleteOne(filter) { const index = messages.findIndex((row) => match(row, filter)); if (index >= 0) messages.splice(index, 1); },
    async updateMany(filter, update) {
      let modifiedCount = 0;
      for (const row of messages.filter((item) => match(item, filter))) { row.readAt = update.$set.readAt; modifiedCount += 1; }
      return { modifiedCount };
    },
    countDocuments(filter) { return countQuery(() => messages.filter((row) => match(row, filter)).length); },
  };
  const Merchant = { findById(id) { return { select() { return this; }, lean: async () => sameId(id, merchantA) ? { _id: merchantA } : sameId(id, merchantB) ? { _id: merchantB } : null }; } };
  const Affiliate = { findById(id) { return { select() { return this; }, lean: async () => sameId(id, affiliateA) ? { _id: affiliateA, status: 'active' } : sameId(id, affiliateB) ? { _id: affiliateB, status: 'active' } : sameId(id, inactiveAffiliate) ? { _id: inactiveAffiliate, status: 'suspended' } : null }; } };
  const Customer = { findById(id) { return { select() { return this; }, lean: async () => sameId(id, customerA) ? { _id: customerA, role: 'user' } : sameId(id, customerB) ? { _id: customerB, role: 'user' } : sameId(id, adminA) ? { _id: adminA, role: 'admin' } : null }; } };
  const startSession = () => ({
    async withTransaction(work) {
      let release;
      const prior = transactionQueue;
      transactionQueue = new Promise((resolve) => { release = resolve; });
      await prior;
      const beforeConversations = conversations.map((row) => ({ ...row }));
      const beforeMessages = messages.map((row) => ({ ...row }));
      try { return await work(this); }
      catch (error) {
        conversations.splice(0, conversations.length, ...beforeConversations);
        messages.splice(0, messages.length, ...beforeMessages);
        throw error;
      } finally { release(); }
    },
    async endSession() {},
  });
  Conversation.aggregate = async (pipeline) => {
    const [{ $match: filter }, { $group: group }] = pipeline;
    const field = group.total.$sum.slice(1);
    const total = conversations.filter((row) => match(row, filter)).reduce((sum, row) => sum + (row[field] || 0), 0);
    return total ? [{ _id: null, total }] : [];
  };
  return { Conversation, Message, Merchant, Affiliate, Customer, conversations, messages, startSession };
}

function response() {
  return { statusCode: 200, body: undefined, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}

async function invoke(controller, method, { actorType = 'customer', actorId = customerA, conversationId, body = {}, query = {} } = {}) {
  const req = {
    user: actorType === 'customer' ? { _id: actorId, role: 'user' } : undefined,
    merchant: actorType === 'merchant' ? { _id: actorId } : undefined,
    affiliate: actorType === 'affiliate' ? { _id: actorId, status: 'active' } : undefined,
    params: { conversationId: conversationId ? String(conversationId) : undefined },
    body: { clientMessageId: `auto-client-${++generatedClientId}`, ...body }, query,
  };
  const res = response();
  await controller[method](req, res);
  return res;
}

async function invokeRouter(router, method, path, { cookies = {}, headers = {}, body = {}, params = {}, query = {} } = {}) {
  const layer = router.stack.find((item) => item.route?.path === path && item.route.methods[method.toLowerCase()]);
  assert.ok(layer, `Missing ${method} ${path}`);
  const req = { cookies, headers, body, params, query, method: method.toUpperCase(), path };
  const res = response();
  const run = async (index) => {
    if (index >= layer.route.stack.length) return;
    const handler = layer.route.stack[index].handle;
    return handler(req, res, (error) => error ? Promise.reject(error) : run(index + 1));
  };
  await run(0);
  return res;
}

let generatedClientId = 0;
function setup() {
  const store = makeStore();
  return { ...store, controller: createMessageController({ ConversationModel: store.Conversation, MessageModel: store.Message, MerchantModel: store.Merchant, AffiliateModel: store.Affiliate, CustomerModel: store.Customer, startSession: store.startSession }) };
}

test('customer creates one conversation and repeated create retrieves it', async () => {
  const { controller, conversations } = setup();
  const first = await invoke(controller, 'createOrGetConversation', { body: { merchantId: String(merchantA) } });
  const second = await invoke(controller, 'createOrGetConversation', { body: { merchantId: String(merchantA) } });
  assert.equal(first.statusCode, 200);
  assert.equal(second.body.conversation.id, first.body.conversation.id);
  assert.equal(conversations.length, 1);
});

test('conversation creation rejects unknown Merchant IDs', async () => {
  const { controller } = setup();
  const result = await invoke(controller, 'createOrGetConversation', { body: { merchantId: String(new mongoose.Types.ObjectId()) } });
  assert.equal(result.statusCode, 404);
});

test('customer and Merchant can exchange persisted messages and unread counts update', async () => {
  const { controller } = setup();
  const made = await invoke(controller, 'createOrGetConversation', { body: { merchantId: String(merchantA) } });
  const id = made.body.conversation.id;
  const sent = await invoke(controller, 'sendMessage', { conversationId: id, body: { text: 'Hello', clientMessageId: 'customer-hello-01' } });
  assert.equal(sent.statusCode, 201);
  assert.equal(sent.body.message.senderType, 'customer');
  const merchantHistory = await invoke(controller, 'listMessages', { actorType: 'merchant', actorId: merchantA, conversationId: id });
  assert.deepEqual(merchantHistory.body.messages.map((message) => message.text), ['Hello']);
  assert.equal((await invoke(controller, 'unreadCount', { actorType: 'merchant', actorId: merchantA })).body.unreadCount, 1);
  const reply = await invoke(controller, 'sendMessage', { actorType: 'merchant', actorId: merchantA, conversationId: id, body: { text: 'Hi back', clientMessageId: 'merchant-reply-01' } });
  assert.equal(reply.body.message.senderType, 'merchant');
  const customerHistory = await invoke(controller, 'listMessages', { conversationId: id });
  assert.deepEqual(customerHistory.body.messages.map((message) => message.text), ['Hello', 'Hi back']);
  assert.equal((await invoke(controller, 'unreadCount')).body.unreadCount, 1);
});

test('conversation lists are scoped to the authenticated Customer or Merchant', async () => {
  const { controller } = setup();
  const made = await invoke(controller, 'createOrGetConversation', { body: { merchantId: String(merchantA) } });
  const customerList = await invoke(controller, 'listConversations');
  const merchantList = await invoke(controller, 'listConversations', { actorType: 'merchant', actorId: merchantA });
  const otherMerchantList = await invoke(controller, 'listConversations', { actorType: 'merchant', actorId: merchantB });
  assert.equal(customerList.body.conversations[0].id, made.body.conversation.id);
  assert.equal(merchantList.body.conversations[0].id, made.body.conversation.id);
  assert.deepEqual(otherMerchantList.body.conversations, []);
});

test('only participants can fetch a conversation or its messages', async () => {
  const { controller } = setup();
  const made = await invoke(controller, 'createOrGetConversation', { body: { merchantId: String(merchantA) } });
  const id = made.body.conversation.id;
  assert.equal((await invoke(controller, 'getConversation', { actorId: customerB, conversationId: id })).statusCode, 404);
  assert.equal((await invoke(controller, 'getConversation', { actorType: 'merchant', actorId: merchantB, conversationId: id })).statusCode, 404);
  assert.equal((await invoke(controller, 'listMessages', { actorId: customerB, conversationId: id })).statusCode, 404);
});

test('sender identity is derived from auth and cannot be spoofed by the body', async () => {
  const { controller } = setup();
  const made = await invoke(controller, 'createOrGetConversation', { body: { merchantId: String(merchantA) } });
  const sent = await invoke(controller, 'sendMessage', { conversationId: made.body.conversation.id, body: { text: 'Only customer', senderId: String(merchantA), senderType: 'merchant' } });
  assert.equal(sent.body.message.senderType, 'customer');
  assert.equal(sent.body.message.senderId, String(customerA));
});

test('read receipt marks received messages only and clears the recipient unread count', async () => {
  const { controller, messages } = setup();
  const made = await invoke(controller, 'createOrGetConversation', { body: { merchantId: String(merchantA) } });
  const id = made.body.conversation.id;
  await invoke(controller, 'sendMessage', { conversationId: id, body: { text: 'Customer message', clientMessageId: 'customer-read-01' } });
  await invoke(controller, 'sendMessage', { actorType: 'merchant', actorId: merchantA, conversationId: id, body: { text: 'Merchant reply', clientMessageId: 'merchant-read-01' } });
  const read = await invoke(controller, 'markRead', { conversationId: id });
  assert.equal(read.body.markedRead, 1);
  assert.ok(messages[1].readAt);
  assert.equal(messages[0].readAt, null);
  assert.equal((await invoke(controller, 'unreadCount')).body.unreadCount, 0);
});

test('message history is chronological and returns a bounded cursor page', async () => {
  const { controller } = setup();
  const made = await invoke(controller, 'createOrGetConversation', { body: { merchantId: String(merchantA) } });
  const id = made.body.conversation.id;
  await invoke(controller, 'sendMessage', { conversationId: id, body: { text: 'One', clientMessageId: 'customer-page-01' } });
  await invoke(controller, 'sendMessage', { conversationId: id, body: { text: 'Two', clientMessageId: 'customer-page-02' } });
  const page = await invoke(controller, 'listMessages', { conversationId: id, query: { limit: '1' } });
  assert.deepEqual(page.body.messages.map((message) => message.text), ['Two']);
  assert.equal(page.body.hasMore, true);
  const older = await invoke(controller, 'listMessages', { conversationId: id, query: { limit: '1', before: page.body.nextCursor } });
  assert.deepEqual(older.body.messages.map((message) => message.text), ['One']);
});

test('invalid IDs, invalid cursors, and empty or oversized messages are rejected', async () => {
  const { controller } = setup();
  assert.equal((await invoke(controller, 'getConversation', { conversationId: 'bad-id' })).statusCode, 400);
  assert.equal((await invoke(controller, 'listMessages', { conversationId: String(merchantA), query: { before: 'garbage' } })).statusCode, 400);
  assert.equal((await invoke(controller, 'sendMessage', { conversationId: String(merchantA), body: { text: '  ', clientMessageId: 'customer-invalid-01' } })).statusCode, 400);
  assert.equal((await invoke(controller, 'sendMessage', { conversationId: String(merchantA), body: { text: 'x'.repeat(2001), clientMessageId: 'customer-invalid-02' } })).statusCode, 400);
  assert.equal((await invoke(controller, 'sendMessage', { conversationId: String(merchantA), body: { text: 'Valid text', clientMessageId: 'bad id' } })).statusCode, 400);
});

test('router authenticates the selected account when both sessions are present and rejects invalid selection', async () => {
  const { Conversation, Message, Merchant, startSession } = makeStore();
  const controller = createMessageController({ ConversationModel: Conversation, MessageModel: Message, MerchantModel: Merchant, startSession });
  const customerAuth = (req, res, next) => {
    if (!['valid-customer', 'admin-customer'].includes(req.cookies?.token)) return res.status(401).json({ message: 'Not authorized' });
    req.user = { _id: customerA, role: req.cookies.token === 'admin-customer' ? 'admin' : 'user' };
    return next();
  };
  const merchantAuth = (req, res, next) => {
    if (req.cookies?.merchantToken !== 'valid-merchant') return res.status(401).json({ message: 'Merchant not authenticated' });
    req.merchant = { _id: merchantA };
    return next();
  };
  const router = createMessagesRouter({ customerAuth, merchantAuth, controller });
  assert.equal((await invokeRouter(router, 'GET', '/conversations')).statusCode, 401);
  assert.equal((await invokeRouter(router, 'GET', '/conversations', { cookies: { token: 'invalid' } })).statusCode, 401);
  assert.equal((await invokeRouter(router, 'GET', '/conversations', { cookies: { merchantToken: 'invalid' } })).statusCode, 401);
  const bothCookies = { token: 'valid-customer', merchantToken: 'valid-merchant' };
  assert.equal((await invokeRouter(router, 'GET', '/conversations', { cookies: bothCookies })).statusCode, 400);
  assert.equal((await invokeRouter(router, 'GET', '/conversations', { cookies: bothCookies, headers: { 'x-messaging-account-type': 'merchant' } })).statusCode, 200);
  assert.equal((await invokeRouter(router, 'GET', '/conversations', { cookies: bothCookies, headers: { 'x-messaging-account-type': 'customer' } })).statusCode, 200);
  assert.equal((await invokeRouter(router, 'GET', '/conversations', { cookies: bothCookies, headers: { 'x-messaging-account-type': 'vendor' } })).statusCode, 400);
  assert.equal((await invokeRouter(router, 'GET', '/conversations', { cookies: { merchantToken: 'valid-merchant' }, headers: { 'x-messaging-account-type': 'customer' } })).statusCode, 401);
  const created = await invokeRouter(router, 'POST', '/conversations', { cookies: bothCookies, headers: { 'x-messaging-account-type': 'customer' }, body: { merchantId: String(merchantA) } });
  assert.equal(created.statusCode, 200);
  const conversationId = created.body.conversation.id;
  const merchantSend = await invokeRouter(router, 'POST', '/conversations/:conversationId/messages', {
    cookies: bothCookies, headers: { 'x-messaging-account-type': 'merchant' }, params: { conversationId },
    body: { text: 'Merchant reply', clientMessageId: 'merchant-dual-0001', senderId: String(customerA), senderType: 'customer' },
  });
  assert.equal(merchantSend.body.message.senderType, 'merchant');
  assert.equal(merchantSend.body.message.senderId, String(merchantA));
  const customerSend = await invokeRouter(router, 'POST', '/conversations/:conversationId/messages', {
    cookies: bothCookies, headers: { 'x-messaging-account-type': 'customer' }, params: { conversationId },
    body: { text: 'Customer reply', clientMessageId: 'customer-dual-0001', senderId: String(merchantA), senderType: 'merchant' },
  });
  assert.equal(customerSend.body.message.senderType, 'customer');
  assert.equal(customerSend.body.message.senderId, String(customerA));
  assert.equal((await invokeRouter(router, 'POST', '/conversations', { cookies: { merchantToken: 'valid-merchant' }, body: { merchantId: String(merchantA) } })).statusCode, 403);
  assert.equal((await invokeRouter(router, 'POST', '/conversations', { cookies: { token: 'valid-customer' }, body: { merchantId: String(merchantA) } })).statusCode, 200);
  assert.equal((await invokeRouter(router, 'GET', '/conversations', { cookies: { token: 'admin-customer' } })).statusCode, 403);
});

test('same sender retries return the original message and do not increment unread twice', async () => {
  const { controller, conversations, messages } = setup();
  const made = await invoke(controller, 'createOrGetConversation', { body: { merchantId: String(merchantA) } });
  const conversationId = made.body.conversation.id;
  const first = await invoke(controller, 'sendMessage', { conversationId, body: { text: 'Retry safe', clientMessageId: 'same-send-0001' } });
  const retry = await invoke(controller, 'sendMessage', { conversationId, body: { text: 'Retry safe', clientMessageId: 'same-send-0001' } });
  assert.equal(first.statusCode, 201);
  assert.equal(retry.statusCode, 200);
  assert.equal(retry.body.idempotentReplay, true);
  assert.equal(retry.body.message.id, first.body.message.id);
  assert.equal(messages.length, 1);
  assert.equal(conversations[0].merchantUnreadCount, 1);
});

test('the same client message ID is isolated by sender identity', async () => {
  const { controller, conversations, messages } = setup();
  const made = await invoke(controller, 'createOrGetConversation', { body: { merchantId: String(merchantA) } });
  const conversationId = made.body.conversation.id;
  await invoke(controller, 'sendMessage', { conversationId, body: { text: 'Customer', clientMessageId: 'shared-key-0001' } });
  const merchant = await invoke(controller, 'sendMessage', { actorType: 'merchant', actorId: merchantA, conversationId, body: { text: 'Merchant', clientMessageId: 'shared-key-0001' } });
  assert.equal(merchant.statusCode, 201);
  assert.equal(messages.length, 2);
  assert.equal(conversations[0].merchantUnreadCount, 1);
  assert.equal(conversations[0].customerUnreadCount, 1);
});

test('parallel send retries serialize through the transaction boundary in the unit double', async () => {
  const { controller, conversations, messages } = setup();
  const made = await invoke(controller, 'createOrGetConversation', { body: { merchantId: String(merchantA) } });
  const conversationId = made.body.conversation.id;
  const results = await Promise.all(Array.from({ length: 8 }, () => invoke(controller, 'sendMessage', { conversationId, body: { text: 'One logical send', clientMessageId: 'parallel-send-01' } })));
  assert.equal(results.filter((item) => item.statusCode === 201).length, 1);
  assert.equal(results.filter((item) => item.statusCode === 200).length, 7);
  assert.equal(messages.length, 1);
  assert.equal(conversations[0].merchantUnreadCount, 1);
});

test('parallel distinct sends preserve each unread increment in the serialized unit double', async () => {
  const { controller, conversations, messages } = setup();
  const made = await invoke(controller, 'createOrGetConversation', { body: { merchantId: String(merchantA) } });
  const conversationId = made.body.conversation.id;
  const results = await Promise.all(Array.from({ length: 12 }, (_, index) => invoke(controller, 'sendMessage', { conversationId, body: { text: `Message ${index}`, clientMessageId: `parallel-distinct-${index}` } })));
  assert.ok(results.every((item) => item.statusCode === 201));
  assert.equal(messages.length, 12);
  assert.equal(conversations[0].merchantUnreadCount, 12);
});

test('concurrent read retries transition messages once and leave the cached unread count at zero', async () => {
  const { controller, conversations, messages } = setup();
  const made = await invoke(controller, 'createOrGetConversation', { body: { merchantId: String(merchantA) } });
  const conversationId = made.body.conversation.id;
  for (let index = 0; index < 3; index += 1) {
    await invoke(controller, 'sendMessage', { conversationId, body: { text: `Message ${index}`, clientMessageId: `read-test-000${index}` } });
  }
  const reads = await Promise.all([
    invoke(controller, 'markRead', { actorType: 'merchant', actorId: merchantA, conversationId }),
    invoke(controller, 'markRead', { actorType: 'merchant', actorId: merchantA, conversationId }),
  ]);
  assert.deepEqual(reads.map((item) => item.body.markedRead).sort(), [0, 3]);
  assert.equal(conversations[0].merchantUnreadCount, 0);
  assert.ok(messages.every((message) => message.readAt));
});

test('send and read interleaving keeps count equal to unread incoming messages in the serialized unit double', async () => {
  const { controller, conversations, messages } = setup();
  const made = await invoke(controller, 'createOrGetConversation', { body: { merchantId: String(merchantA) } });
  const conversationId = made.body.conversation.id;
  await invoke(controller, 'sendMessage', { conversationId, body: { text: 'Before read', clientMessageId: 'read-race-0001' } });
  await Promise.all([
    invoke(controller, 'markRead', { actorType: 'merchant', actorId: merchantA, conversationId }),
    invoke(controller, 'sendMessage', { conversationId, body: { text: 'During read', clientMessageId: 'read-race-0002' } }),
  ]);
  const unread = messages.filter((message) => message.senderType === 'customer' && !message.readAt).length;
  assert.equal(conversations[0].merchantUnreadCount, unread);
});

test('transaction failure returns an error and message creation failure does not alter conversation counters', async () => {
  const store = makeStore();
  const controller = createMessageController({
    ConversationModel: store.Conversation,
    MessageModel: store.Message,
    MerchantModel: store.Merchant,
    startSession: async () => ({
      async withTransaction() { throw Object.assign(new Error('transactions are not supported'), { code: 20 }); },
      async endSession() {},
    }),
  });
  const made = await invoke(controller, 'createOrGetConversation', { body: { merchantId: String(merchantA) } });
  const unavailable = await invoke(controller, 'sendMessage', { conversationId: made.body.conversation.id, body: { text: 'No standalone write', clientMessageId: 'transaction-001' } });
  assert.equal(unavailable.statusCode, 503);
  assert.equal(store.messages.length, 0);

  const second = setup();
  const secondMade = await invoke(second.controller, 'createOrGetConversation', { body: { merchantId: String(merchantA) } });
  second.Message.create = async () => { throw new Error('simulated create failure'); };
  const failed = await invoke(second.controller, 'sendMessage', { conversationId: secondMade.body.conversation.id, body: { text: 'Cannot persist', clientMessageId: 'create-failure-01' } });
  assert.equal(failed.statusCode, 500);
  assert.equal(second.conversations[0].merchantUnreadCount, 0);
});

test('conversation update failure rolls back a message in the transaction unit double', async () => {
  const store = setup();
  const made = await invoke(store.controller, 'createOrGetConversation', { body: { merchantId: String(merchantA) } });
  store.Conversation.updateOne = async () => { throw new Error('simulated conversation write failure'); };
  const failed = await invoke(store.controller, 'sendMessage', { conversationId: made.body.conversation.id, body: { text: 'Must roll back', clientMessageId: 'update-failure-01' } });
  assert.equal(failed.statusCode, 500);
  assert.equal(store.messages.length, 0);
  assert.equal(store.conversations[0].merchantUnreadCount, 0);
});

test('simultaneous conversation upsert duplicate-key recovery returns one resource in the unit double', async () => {
  const store = setup();
  const original = store.Conversation.findOneAndUpdate;
  let arrivals = 0;
  let open;
  const barrier = new Promise((resolve) => { open = resolve; });
  let winnerCreated = false;
  store.Conversation.findOneAndUpdate = async (...args) => {
    arrivals += 1;
    if (arrivals === 2) open();
    await barrier;
    if (winnerCreated) throw Object.assign(new Error('duplicate key'), { code: 11000 });
    winnerCreated = true;
    return original(...args);
  };
  const create = () => invoke(store.controller, 'createOrGetConversation', { body: { merchantId: String(merchantA) } });
  const results = await Promise.all([create(), create()]);
  assert.equal(results[0].statusCode, 200);
  assert.equal(results[1].statusCode, 200);
  assert.equal(results[0].body.conversation.id, results[1].body.conversation.id);
  assert.equal(store.conversations.length, 1);
});

test('conversation cursor pagination handles over 100 rows and tied timestamps without duplicates', async () => {
  const { controller, conversations } = setup();
  const timestamp = new Date('2026-10-31T12:00:00.000Z');
  for (let index = 0; index < 105; index += 1) {
    conversations.push({ _id: new mongoose.Types.ObjectId(), customerId: new mongoose.Types.ObjectId(), merchantId: merchantA, lastMessage: '', lastMessageAt: null, customerUnreadCount: 0, merchantUnreadCount: 0, createdAt: timestamp, updatedAt: timestamp });
  }
  const all = [];
  let before;
  do {
    const result = await invoke(controller, 'listConversations', { actorType: 'merchant', actorId: merchantA, query: { limit: '100', ...(before ? { before } : {}) } });
    all.push(...result.body.conversations.map((row) => row.id));
    before = result.body.nextCursor;
  } while (before);
  assert.equal(all.length, 105);
  assert.equal(new Set(all).size, 105);
});

test('messaging index readiness verifies declared indexes and fails closed when one is missing', async () => {
  const makeIndexModel = (name, specs) => ({
    modelName: name,
    collection: { collectionName: name.toLowerCase() },
    db: { db: {
      listCollections() { return { async hasNext() { return true; } }; },
      collection() { return { listIndexes() { return { async toArray() { return specs.map((spec) => ({ ...spec, key: { ...spec.key } })); } }; } }; },
    } },
  });
  await ensureMessagingIndexes(makeIndexModel('Conversation', CONVERSATION_INDEXES), makeIndexModel('Message', MESSAGE_INDEXES));
  await assert.rejects(
    ensureMessagingIndexes(makeIndexModel('Conversation', CONVERSATION_INDEXES.slice(1)), makeIndexModel('Message', MESSAGE_INDEXES)),
    (error) => error.code === 'MESSAGING_INDEX_NOT_READY',
  );
  await assert.rejects(
    ensureMessagingIndexes(makeIndexModel('Conversation', [
      ...CONVERSATION_INDEXES,
      { name: 'renamed_legacy_index', key: { customerId: 1, merchantId: 1 }, unique: true },
    ]), makeIndexModel('Message', MESSAGE_INDEXES)),
    (error) => error.code === 'MESSAGING_INDEX_NOT_READY' && /obsolete full unique Customer-Merchant index.*renamed_legacy_index/.test(error.message),
  );
});

test('unread aggregation matches Customer and Merchant participant IDs as BSON ObjectIds', async () => {
  const store = setup();
  const otherCustomer = new mongoose.Types.ObjectId();
  const otherMerchant = new mongoose.Types.ObjectId();
  store.conversations.push(
    { customerId: customerA, merchantId: merchantA, customerUnreadCount: 3, merchantUnreadCount: 5 },
    { customerId: otherCustomer, merchantId: merchantA, customerUnreadCount: 11, merchantUnreadCount: 7 },
    { customerId: customerA, merchantId: otherMerchant, customerUnreadCount: 13, merchantUnreadCount: 17 },
  );

  store.Conversation.aggregate = async ([matchStage, groupStage]) => {
    const [field, expectedId] = Object.entries(matchStage.$match)[0];
    assert.ok(expectedId instanceof mongoose.Types.ObjectId);
    const matching = store.conversations.filter((conversation) => conversation[field].equals(expectedId));
    const unreadField = groupStage.$group.total.$sum.slice(1);
    const total = matching.reduce((sum, conversation) => sum + conversation[unreadField], 0);
    return total ? [{ _id: null, total }] : [];
  };

  const customerResult = await invoke(store.controller, 'unreadCount', { actorType: 'customer', actorId: customerA });
  assert.equal(customerResult.body.unreadCount, 16);

  const merchantResult = await invoke(store.controller, 'unreadCount', { actorType: 'merchant', actorId: merchantA });
  assert.equal(merchantResult.body.unreadCount, 12);
});

test('Customer and Affiliate can create, list, send, read, and count a separate conversation', async () => {
  const store = setup();
  const affiliateStarted = await invoke(store.controller, 'createOrGetConversation', {
    actorType: 'affiliate', actorId: affiliateA, body: { customerId: String(customerA) },
  });
  assert.equal(affiliateStarted.statusCode, 200);
  assert.equal(affiliateStarted.body.conversation.customerId, String(customerA));
  assert.equal(affiliateStarted.body.conversation.affiliateId, String(affiliateA));
  const first = await invoke(store.controller, 'createOrGetConversation', { body: { affiliateId: String(affiliateA) } });
  const second = await invoke(store.controller, 'createOrGetConversation', { body: { affiliateId: String(affiliateA) } });
  assert.equal(first.statusCode, 200);
  assert.equal(first.body.conversation.id, affiliateStarted.body.conversation.id);
  assert.equal(second.body.conversation.id, first.body.conversation.id);
  assert.equal(first.body.conversation.affiliateId, String(affiliateA));
  assert.equal(first.body.conversation.recipientType, 'affiliate');
  assert.equal(store.conversations[0].merchantId, undefined);
  assert.equal(store.conversations[0].affiliateUnreadCount, 0);

  const conversationId = first.body.conversation.id;
  assert.equal((await invoke(store.controller, 'getConversation', { actorType: 'affiliate', actorId: affiliateB, conversationId })).statusCode, 404);
  assert.equal((await invoke(store.controller, 'listMessages', { actorType: 'affiliate', actorId: affiliateB, conversationId })).statusCode, 404);
  const customerSend = await invoke(store.controller, 'sendMessage', {
    conversationId, body: { text: 'Hi Affiliate', clientMessageId: 'customer-aff-0001', senderId: String(affiliateB), senderType: 'affiliate' },
  });
  assert.equal(customerSend.body.message.senderType, 'customer');
  assert.equal(customerSend.body.message.senderId, String(customerA));
  assert.equal(store.conversations[0].affiliateUnreadCount, 1);

  const affiliateSend = await invoke(store.controller, 'sendMessage', {
    actorType: 'affiliate', actorId: affiliateA, conversationId,
    body: { text: 'Hello Customer', clientMessageId: 'affiliate-msg-001', senderId: String(customerB), senderType: 'customer' },
  });
  assert.equal(affiliateSend.body.message.senderType, 'affiliate');
  assert.equal(affiliateSend.body.message.senderId, String(affiliateA));
  assert.equal(store.conversations[0].customerUnreadCount, 1);

  const affiliateList = await invoke(store.controller, 'listConversations', { actorType: 'affiliate', actorId: affiliateA });
  assert.equal(affiliateList.body.conversations[0].id, conversationId);
  assert.equal((await invoke(store.controller, 'unreadCount', { actorType: 'affiliate', actorId: affiliateA })).body.unreadCount, 1);
  assert.equal((await invoke(store.controller, 'unreadCount', { actorType: 'customer', actorId: customerA })).body.unreadCount, 1);

  const affiliateRead = await invoke(store.controller, 'markRead', { actorType: 'affiliate', actorId: affiliateA, conversationId });
  assert.equal(affiliateRead.body.markedRead, 1);
  assert.equal(store.messages[0].readAt !== null, true);
  assert.equal(store.conversations[0].affiliateUnreadCount, 0);
  const customerRead = await invoke(store.controller, 'markRead', { conversationId });
  assert.equal(customerRead.body.markedRead, 1);
  assert.equal(store.conversations[0].customerUnreadCount, 0);
});

test('Customer conversation creation requires exactly one existing recipient', async () => {
  const { controller, conversations } = setup();
  assert.equal((await invoke(controller, 'createOrGetConversation', { body: {} })).statusCode, 400);
  assert.equal((await invoke(controller, 'createOrGetConversation', { body: { merchantId: String(merchantA), affiliateId: String(affiliateA) } })).statusCode, 400);
  assert.equal((await invoke(controller, 'createOrGetConversation', { body: { affiliateId: String(new mongoose.Types.ObjectId()) } })).statusCode, 404);
  assert.equal((await invoke(controller, 'createOrGetConversation', { body: { affiliateId: String(inactiveAffiliate) } })).statusCode, 404);
  assert.equal(conversations.length, 0);
});

test('Affiliate initiation rejects Admin and nonexistent Customers and cannot supply sender identity', async () => {
  const { controller, conversations } = setup();
  for (const customerId of [String(adminA), String(new mongoose.Types.ObjectId())]) {
    const result = await invoke(controller, 'createOrGetConversation', { actorType: 'affiliate', body: { customerId } });
    assert.equal(result.statusCode, 404);
  }
  const spoof = await invoke(controller, 'createOrGetConversation', {
    actorType: 'affiliate', body: { customerId: String(customerA), affiliateId: String(affiliateB) },
  });
  assert.equal(spoof.statusCode, 400);
  assert.equal(conversations.length, 0);
});

test('router isolates account selection and permits only authenticated Customer or Affiliate starts', async () => {
  const store = makeStore();
  const controller = createMessageController({ ConversationModel: store.Conversation, MessageModel: store.Message, MerchantModel: store.Merchant, AffiliateModel: store.Affiliate, CustomerModel: store.Customer, startSession: store.startSession });
  const customerAuth = (req, res, next) => {
    if (req.cookies?.token !== 'valid-customer') return res.status(401).json({ message: 'Not authorized' });
    req.user = { _id: customerA, role: 'user' };
    return next();
  };
  const affiliateAuth = (req, res, next) => {
    if (req.cookies?.affiliateToken !== 'valid-affiliate') return res.status(401).json({ message: 'Affiliate not authenticated' });
    req.affiliate = { _id: affiliateA, status: 'active' };
    return next();
  };
  const merchantAuth = (req, res, next) => { req.merchant = { _id: merchantA }; return next(); };
  const router = createMessagesRouter({ customerAuth, merchantAuth, affiliateAuth, controller });
  assert.equal((await invokeRouter(router, 'GET', '/conversations')).statusCode, 401);
  assert.equal((await invokeRouter(router, 'GET', '/conversations', { cookies: { affiliateToken: 'valid-affiliate' } })).statusCode, 200);
  assert.equal((await invokeRouter(router, 'GET', '/conversations', { cookies: { affiliateToken: 'valid-affiliate', token: 'valid-customer' } })).statusCode, 400);
  assert.equal((await invokeRouter(router, 'GET', '/conversations', { cookies: { token: 'valid-customer' }, headers: { 'x-messaging-account-type': 'affiliate' } })).statusCode, 401);
  assert.equal((await invokeRouter(router, 'GET', '/conversations', { cookies: { affiliateToken: 'valid-affiliate' }, headers: { 'x-messaging-account-type': 'customer' } })).statusCode, 401);

  const made = await invokeRouter(router, 'POST', '/conversations', {
    cookies: { token: 'valid-customer' }, body: { affiliateId: String(affiliateA) },
  });
  assert.equal(made.statusCode, 200);
  const conversationId = made.body.conversation.id;
  const reply = await invokeRouter(router, 'POST', '/conversations/:conversationId/messages', {
    cookies: { affiliateToken: 'valid-affiliate' }, params: { conversationId },
    body: { text: 'Affiliate reply', clientMessageId: 'router-aff-msg-01', senderId: String(customerB), senderType: 'customer' },
  });
  assert.equal(reply.body.message.senderType, 'affiliate');
  assert.equal(reply.body.message.senderId, String(affiliateA));
  const affiliateStarted = await invokeRouter(router, 'POST', '/conversations', {
    cookies: { affiliateToken: 'valid-affiliate' }, body: { customerId: String(customerB), affiliateId: String(affiliateB) },
  });
  assert.equal(affiliateStarted.statusCode, 400);
  const validAffiliateStart = await invokeRouter(router, 'POST', '/conversations', {
    cookies: { affiliateToken: 'valid-affiliate' }, body: { customerId: String(customerB) },
  });
  assert.equal(validAffiliateStart.statusCode, 200);
  assert.equal(validAffiliateStart.body.conversation.affiliateId, String(affiliateA));
  assert.equal((await invokeRouter(router, 'POST', '/conversations', {
    cookies: { merchantToken: 'valid-merchant' }, body: { merchantId: String(merchantA) },
  })).statusCode, 403);
});

test('Conversation schema enforces one recipient and declares partial pair indexes', async () => {
  const validMerchant = new ConversationModel({ customerId: customerA, merchantId: merchantA });
  const validAffiliate = new ConversationModel({ customerId: customerA, affiliateId: affiliateA });
  await assert.doesNotReject(validMerchant.validate());
  await assert.doesNotReject(validAffiliate.validate());
  await assert.rejects(new ConversationModel({ customerId: customerA }).validate(), /exactly one Merchant or Affiliate/);
  await assert.rejects(new ConversationModel({ customerId: customerA, merchantId: merchantA, affiliateId: affiliateA }).validate(), /exactly one Merchant or Affiliate/);

  const indexes = ConversationModel.schema.indexes();
  assert.ok(indexes.some(([key, options]) => key.customerId === 1 && key.merchantId === 1 && options.unique && options.partialFilterExpression?.merchantId?.$type === 'objectId'));
  assert.ok(indexes.some(([key, options]) => key.customerId === 1 && key.affiliateId === 1 && options.unique && options.partialFilterExpression?.affiliateId?.$type === 'objectId'));
  assert.ok(indexes.some(([key, options]) => key.affiliateId === 1 && key.updatedAt === -1 && options.name === 'affiliate_conversation_list'));
  assert.ok(MessageModel.schema.path('senderType').enumValues.includes('affiliate'));
});

