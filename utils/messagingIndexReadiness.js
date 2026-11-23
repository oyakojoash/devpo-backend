const { inspectCollectionIndexes } = require('./readOnlyIndexInspection');
const CONVERSATION_INDEXES = [
  {
    name: 'uniq_customer_merchant_conversation_v2',
    key: { customerId: 1, merchantId: 1 },
    unique: true,
    partialFilterExpression: { merchantId: { $type: 'objectId' } },
  },
  {
    name: 'uniq_customer_affiliate_conversation',
    key: { customerId: 1, affiliateId: 1 },
    unique: true,
    partialFilterExpression: { affiliateId: { $type: 'objectId' } },
  },
  { name: 'customer_conversation_list', key: { customerId: 1, updatedAt: -1, _id: -1 } },
  { name: 'merchant_conversation_list', key: { merchantId: 1, updatedAt: -1, _id: -1 } },
  { name: 'affiliate_conversation_list', key: { affiliateId: 1, updatedAt: -1, _id: -1 } },
];
const MESSAGE_INDEXES = [
  { name: 'conversation_message_history', key: { conversationId: 1, createdAt: -1, _id: -1 } },
  { name: 'conversation_unread_messages', key: { conversationId: 1, senderType: 1, readAt: 1 } },
  {
    name: 'uniq_sender_client_message',
    key: { conversationId: 1, senderType: 1, senderId: 1, clientMessageId: 1 },
    unique: true,
    partialFilterExpression: { clientMessageId: { $type: 'string' } },
  },
];

function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortObject(value[key])]));
}

function comparableOptions(index) {
  const ignored = new Set(['name', 'key', 'v', 'ns', 'background']);
  return Object.fromEntries(Object.entries(index || {}).filter(([key]) => !ignored.has(key)));
}

function matchesSpec(index, spec) {
  if (!index || index.name !== spec.name || JSON.stringify(index.key) !== JSON.stringify(spec.key)) return false;
  return JSON.stringify(sortObject(comparableOptions(index))) === JSON.stringify(sortObject(comparableOptions(spec)));
}

function isObsoleteCustomerMerchantIndex(index) {
  return Boolean(index?.unique)
    && JSON.stringify(index.key) === JSON.stringify({ customerId: 1, merchantId: 1 })
    && !index.partialFilterExpression;
}

async function verifyModelIndexes(Model, specs, obsoletePredicate = () => false) {
  const indexes = await inspectCollectionIndexes(Model);
  const missing = specs.filter((spec) => !indexes.some((index) => matchesSpec(index, spec)));
  const obsolete = indexes.filter(obsoletePredicate);
  const conflicts = indexes.filter((index) => Boolean(index?.unique) && specs.some((spec) => (
    Boolean(spec.unique)
    && JSON.stringify(index.key) === JSON.stringify(spec.key)
    && !matchesSpec(index, spec)
  )));
  if (missing.length || obsolete.length || conflicts.length) {
    const details = [
      ...(missing.length ? [`missing or unexpected: ${missing.map((item) => item.name).join(', ')}`] : []),
      ...(obsolete.length ? [`obsolete full unique Customer-Merchant index: ${obsolete.map((item) => `${item.name} (${JSON.stringify(item.key)})`).join(', ')}`] : []),
      ...(conflicts.length ? [`conflicting unique index specifications: ${conflicts.map((item) => `${item.name} (${JSON.stringify(comparableOptions(item))})`).join(', ')}`] : []),
    ].join('; ');
    const error = new Error(`Messaging indexes are not ready: ${details}`);
    error.code = 'MESSAGING_INDEX_NOT_READY';
    throw error;
  }
}

async function ensureMessagingIndexes(ConversationModel, MessageModel) {
  await Promise.all([
    verifyModelIndexes(ConversationModel, CONVERSATION_INDEXES, isObsoleteCustomerMerchantIndex),
    verifyModelIndexes(MessageModel, MESSAGE_INDEXES),
  ]);
}

module.exports = { ensureMessagingIndexes, matchesSpec, isObsoleteCustomerMerchantIndex, CONVERSATION_INDEXES, MESSAGE_INDEXES };
