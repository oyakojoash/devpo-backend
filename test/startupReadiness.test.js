const { test } = require('node:test');
const assert = require('node:assert/strict');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const Order = require('../models/Order');
const { inspectCollectionIndexes } = require('../utils/readOnlyIndexInspection');
const {
  CONVERSATION_INDEXES,
  MESSAGE_INDEXES,
  ensureMessagingIndexes,
} = require('../utils/messagingIndexReadiness');
const { REQUIRED_INDEXES, ensureAffiliateReferralIndexes } = require('../utils/affiliateReferralIndexReadiness');

process.env.JWT_SECRET ||= 'unit-test-secret-that-is-at-least-thirty-two-characters';
process.env.MONGO_URI ||= 'mongodb://127.0.0.1:27017/unit-test-only';
const { start } = require('../server');

const requiredIndex = {
  name: 'user_1_idempotencyKey_1',
  key: { user: 1, idempotencyKey: 1 },
  unique: true,
  partialFilterExpression: { idempotencyKey: { $type: 'string' } },
};

function makeStartup({ indexes = [requiredIndex], collectionExists = true, inspectError, affiliateReadiness, referralReadiness } = {}) {
  const events = [];
  const logs = [];
  const orderModel = {
    modelName: 'Order',
    collection: { collectionName: 'orders' },
    db: { db: {
      listCollections(filter, options) {
        events.push('list-collections');
        assert.deepEqual(filter, { name: 'orders' });
        assert.deepEqual(options, { nameOnly: true });
        return { async hasNext() { return collectionExists; } };
      },
      collection(name) {
        assert.equal(name, 'orders');
        return { listIndexes() {
          events.push('list-indexes');
          return { async toArray() { if (inspectError) throw inspectError; return indexes; } };
        } };
      },
    } },
    async init() { throw new Error('readiness must never initialize model indexes'); },
  };
  const dbConnection = {
    async connect() { events.push('connect'); },
    connection: { db: {} },
    mongo: { GridFSBucket: class { constructor() { events.push('bucket'); } } },
    async disconnect() {},
  };
  const expressApp = {
    locals: {},
    listen(_port, callback) {
      events.push('listen');
      callback();
      return { close() {} };
    },
  };
  return {
    events,
    logs,
    run: () => start({
      dbConnection,
      orderModel,
      expressApp,
      port: 0,
      processHooks: { on() {}, exit() {} },
      logger: { log() {}, error(...args) { logs.push(args); } },
      affiliatePromotionIndexReadiness: affiliateReadiness,
      affiliateReferralIndexReadiness: referralReadiness,
    }),
  };
}

test('startup inspects existing indexes before listening without initializing model indexes', async () => {
  const startup = makeStartup();
  await startup.run();
  assert.deepEqual(startup.events, ['connect', 'list-collections', 'list-indexes', 'bucket', 'listen']);
});

test('index inspection failure logs safely and never starts the listener', async () => {
  const startup = makeStartup({ inspectError: Object.assign(new Error('mongodb://secret@example'), { code: 'EINDEX' }) });
  await assert.rejects(startup.run(), /Required Order idempotency index is not ready/);
  assert.equal(startup.events.includes('listen'), false);
  assert.equal(JSON.stringify(startup.logs).includes('secret'), false);
  assert.match(startup.logs[0][0], /will not start/);
});

test('missing collection fails readiness without creating it', async () => {
  const startup = makeStartup({ collectionExists: false });
  await assert.rejects(startup.run(), /Required Order idempotency index is not ready/);
  assert.equal(startup.events.includes('list-indexes'), false);
  assert.equal(startup.events.includes('listen'), false);
});

test('missing or semantically incorrect index fails closed', async () => {
  const startup = makeStartup({ indexes: [{ key: { _id: 1 }, unique: true }] });
  await assert.rejects(startup.run(), /Required Order idempotency index is not ready/);
  assert.equal(startup.events.includes('listen'), false);
});

test('AffiliatePromotion readiness failure prevents the HTTP listener from starting', async () => {
  const startup = makeStartup({ affiliateReadiness: async () => { throw Object.assign(new Error('missing collection'), { code: 'INDEX_COLLECTION_MISSING' }); } });
  await assert.rejects(startup.run(), /Required AffiliatePromotion index is not ready/);
  assert.equal(startup.events.includes('listen'), false);
  assert.equal(startup.logs.some(([message, metadata]) => /AffiliatePromotion/.test(message) && metadata.code === 'INDEX_COLLECTION_MISSING'), true);
});

test('startup proceeds past AffiliatePromotion readiness when the exact index is ready', async () => {
  const startup = makeStartup({ affiliateReadiness: async () => {} });
  await startup.run();
  assert.deepEqual(startup.events, ['connect', 'list-collections', 'list-indexes', 'bucket', 'listen']);
});

test('referral readiness logs the failing index safely and still fails before listen', async () => {
  const startup = makeStartup({
    affiliateReadiness: async () => {},
    referralReadiness: async () => {
      throw Object.assign(new Error('Required index uniq_affiliate_referral_code for AffiliateReferral is missing or has unexpected options mongodb://user:secret@example/db'), {
        code: 'AFFILIATE_REFERRAL_INDEX_NOT_READY',
      });
    },
  });
  await assert.rejects(startup.run(), /Required Affiliate referral indexes are not ready/);
  assert.equal(startup.events.includes('listen'), false);
  assert.match(startup.logs[0][1].detail, /uniq_affiliate_referral_code/);
  assert.equal(JSON.stringify(startup.logs).includes('secret'), false);
});

test('startup fails closed when the real referral readiness check finds a missing index', async () => {
  const makeReferralModel = (modelName, indexes) => ({
    modelName,
    collection: { collectionName: modelName.toLowerCase() },
    db: { db: {
      listCollections() { return { async hasNext() { return true; } }; },
      collection() { return { listIndexes() { return { async toArray() { return indexes; } }; } }; },
    } },
  });
  const startup = makeStartup({
    affiliateReadiness: async () => {},
    referralReadiness: async () => ensureAffiliateReferralIndexes(
      makeReferralModel('AffiliateReferral', REQUIRED_INDEXES.AffiliateReferral.slice(0, 1)),
      makeReferralModel('AffiliateRecruitmentReferral', REQUIRED_INDEXES.AffiliateRecruitmentReferral),
    ),
  });
  await assert.rejects(startup.run(), /Required Affiliate referral indexes are not ready/);
  assert.equal(startup.events.includes('listen'), false);
  assert.match(startup.logs[0][1].detail, /uniq_affiliate_referral_code/);
});

test('readiness-managed schemas disable automatic index and collection creation', () => {
  for (const Model of [Conversation, Message, Order]) {
    assert.equal(Model.schema.options.autoIndex, false, `${Model.modelName} autoIndex`);
    assert.equal(Model.schema.options.autoCreate, false, `${Model.modelName} autoCreate`);
  }
});

test('native readiness inspection fails on a missing collection without requesting creation', async () => {
  let collectionAccessed = false;
  const Model = {
    modelName: 'MissingModel',
    collection: { collectionName: 'missingmodels' },
    db: { db: {
      listCollections() { return { async hasNext() { return false; } }; },
      collection() { collectionAccessed = true; throw new Error('must not access a missing collection'); },
      createCollection() { throw new Error('readiness must not create collections'); },
    } },
  };
  await assert.rejects(inspectCollectionIndexes(Model), (error) => (
    error.code === 'INDEX_COLLECTION_MISSING' && /collection "missingmodels" does not exist/.test(error.message)
  ));
  assert.equal(collectionAccessed, false);
});

test('messaging readiness accepts exact indexes and rejects conflicting unique options', async () => {
  const makeModel = (modelName, indexes) => ({
    modelName,
    collection: { collectionName: modelName.toLowerCase() },
    db: { db: {
      listCollections() { return { async hasNext() { return true; } }; },
      collection() { return { listIndexes() { return { async toArray() { return indexes; } }; } }; },
    } },
  });
  await ensureMessagingIndexes(
    makeModel('Conversation', CONVERSATION_INDEXES),
    makeModel('Message', MESSAGE_INDEXES),
  );

  const conflictingConversationIndexes = CONVERSATION_INDEXES.map((index) => (
    index.name === 'uniq_customer_merchant_conversation_v2'
      ? { ...index, partialFilterExpression: { merchantId: { $type: 'string' } } }
      : index
  ));
  await assert.rejects(
    ensureMessagingIndexes(
      makeModel('Conversation', conflictingConversationIndexes),
      makeModel('Message', MESSAGE_INDEXES),
    ),
    (error) => error.code === 'MESSAGING_INDEX_NOT_READY' && /conflicting unique index specifications/.test(error.message),
  );
});
