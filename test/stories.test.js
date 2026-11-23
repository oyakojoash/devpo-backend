const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const createStoriesRouter = require('../routes/stories');
const { createStoryController, detectMedia } = require('../controllers/storyController');

const merchantA = new mongoose.Types.ObjectId();
const merchantB = new mongoose.Types.ObjectId();
const storyId = new mongoose.Types.ObjectId();
const validJpeg = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
const validMp4 = Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);

function response() {
  return { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}

function fakeCloudinary({ duration = 4, fail = false } = {}) {
  const calls = { uploads: [], deletes: [] };
  return {
    calls,
    uploader: {
      upload_stream(options, callback) {
        calls.uploads.push(options);
        return { end(buffer) {
          calls.buffer = buffer;
          queueMicrotask(() => fail ? callback(new Error('cloud down')) : callback(null, {
            public_id: 'stories/asset-1', secure_url: 'https://res.cloudinary.com/demo/asset', duration,
          }));
        } };
      },
      destroy(publicId, options, callback) {
        calls.deletes.push({ publicId, options });
        queueMicrotask(() => callback(null, { result: 'ok' }));
      },
    },
  };
}

function publishReq({ type = 'image/jpeg', buffer = validJpeg, body = {}, owner = merchantA } = {}) {
  return { merchant: owner ? { _id: owner } : undefined, body, file: { mimetype: type, buffer, size: buffer.length } };
}

function findQuery(rows) {
  return { sort(value) { this.sortValue = value; return this; }, limit(value) { this.limitValue = value; return this; }, lean: async () => rows };
}

async function call(handler, req) {
  const res = response();
  await handler(req, res);
  return res;
}

test('image and video signatures are checked against the declared formats', () => {
  assert.equal(detectMedia(validJpeg, 'image/jpeg'), 'image');
  assert.equal(detectMedia(validMp4, 'video/mp4'), 'video');
  assert.equal(detectMedia(validJpeg, 'video/mp4'), null);
  assert.equal(detectMedia(Buffer.from('not media'), 'video/webm'), null);
});

test('router requires merchant auth for publishing, own history, and deletion', () => {
  const called = [];
  const protect = (_req, _res, next) => { called.push('auth'); next(); };
  const controller = Object.fromEntries(['publish', 'active', 'mine', 'merchantActive', 'view', 'remove'].map((name) => [name, (_req, _res, next) => { called.push(name); if (next) next(); }]));
  const router = createStoriesRouter({ protect, controller, viewRateLimit: (_req, _res, next) => next() });
  const post = router.stack.find((layer) => layer.route?.path === '/' && layer.route.methods.post).route.stack;
  assert.equal(post[0].handle, protect);
  assert.equal(post.at(-1).handle, controller.publish);
  const mine = router.stack.find((layer) => layer.route?.path === '/my').route.stack;
  assert.equal(mine[0].handle, protect);
  const remove = router.stack.find((layer) => layer.route?.path === '/:storyId' && layer.route.methods.delete).route.stack;
  assert.equal(remove[0].handle, protect);
});

test('merchant publishes an image with server ownership and exact 24-hour expiry', async () => {
  const cloudinary = fakeCloudinary();
  let saved;
  const controller = createStoryController({ cloudinary, now: () => new Date('2026-01-01T00:00:00.000Z'), StoryModel: { async create(value) { saved = { ...value, _id: storyId }; return saved; } } });
  const res = await call(controller.publish, publishReq({ body: { caption: ' Hello ', merchant: String(merchantB), expiresAt: '2000-01-01' } }));
  assert.equal(res.statusCode, 201);
  assert.equal(String(saved.merchant), String(merchantA));
  assert.equal(saved.expiresAt.toISOString(), '2026-01-02T00:00:00.000Z');
  assert.equal(saved.viewsCount, 0);
  assert.equal(saved.caption, 'Hello');
  assert.equal(cloudinary.calls.uploads[0].resource_type, 'image');
});

test('merchant publishes a video through Cloudinary video resource type', async () => {
  const cloudinary = fakeCloudinary({ duration: 60 });
  let saved;
  const controller = createStoryController({ cloudinary, StoryModel: { async create(value) { saved = value; return { ...value, _id: storyId }; } } });
  const res = await call(controller.publish, publishReq({ type: 'video/mp4', buffer: validMp4 }));
  assert.equal(res.statusCode, 201);
  assert.equal(saved.mediaType, 'video');
  assert.equal(cloudinary.calls.uploads[0].resource_type, 'video');
});

test('unauthenticated merchant cannot publish and uploads nothing', async () => {
  const cloudinary = fakeCloudinary();
  const controller = createStoryController({ cloudinary, StoryModel: { create: async () => assert.fail('must not create') } });
  const res = await call(controller.publish, publishReq({ owner: null }));
  assert.equal(res.statusCode, 401);
  assert.equal(cloudinary.calls.uploads.length, 0);
});

test('client cannot choose a different merchant owner', async () => {
  const cloudinary = fakeCloudinary();
  let saved;
  const controller = createStoryController({ cloudinary, StoryModel: { async create(value) { saved = value; return { ...value, _id: storyId }; } } });
  await call(controller.publish, publishReq({ body: { merchantId: String(merchantB), merchant: String(merchantB) } }));
  assert.equal(String(saved.merchant), String(merchantA));
});

test('invalid media and oversized images are rejected before Cloudinary upload', async () => {
  const cloudinary = fakeCloudinary();
  const controller = createStoryController({ cloudinary });
  const bad = await call(controller.publish, publishReq({ buffer: Buffer.from('bad') }));
  assert.equal(bad.statusCode, 400);
  const tooBig = Buffer.concat([validJpeg, Buffer.alloc(5 * 1024 * 1024)]);
  const large = await call(controller.publish, publishReq({ buffer: tooBig }));
  assert.equal(large.statusCode, 413);
  assert.equal(cloudinary.calls.uploads.length, 0);
});

test('video beyond the duration limit is cleaned up and not published', async () => {
  const cloudinary = fakeCloudinary({ duration: 60.1 });
  const controller = createStoryController({ cloudinary, StoryModel: { create: async () => assert.fail('must not create') } });
  const res = await call(controller.publish, publishReq({ type: 'video/mp4', buffer: validMp4 }));
  assert.equal(res.statusCode, 400);
  assert.equal(cloudinary.calls.deletes[0].options.resource_type, 'video');
});

test('active customer feed excludes expired stories and returns only public merchant fields', async () => {
  const active = { _id: storyId, merchant: merchantA, mediaType: 'image', mediaUrl: 'https://cdn.test/a', createdAt: new Date(), expiresAt: new Date(Date.now() + 1000), viewsCount: 2 };
  let filter;
  const controller = createStoryController({
    StoryModel: { find(value) { filter = value; return findQuery([active]); } },
    MerchantModel: { find() { return { select() { return this; }, lean: async () => [{ _id: merchantA, name: 'Shop', email: 'private@example.test', passwordHash: 'secret' }] }; } },
    VendorModel: {
      publicMarketplaceFilter: () => ({ approvalStatus: 'approved', status: 'active' }),
      find(value) {
        return { select() { this.fields = value; return this; }, lean: async () => value.approvalStatus
          ? [{ _id: 'vendor-row', merchantId: merchantA, logo: '/images/shop.png' }]
          : [{ _id: 'vendor-row', merchantId: merchantA }] };
      },
    },
  });
  const res = await call(controller.active, { query: {} });
  assert.ok(filter.expiresAt.$gt instanceof Date);
  assert.equal(res.body.stories.length, 1);
  assert.deepEqual(res.body.stories[0].merchant, { id: String(merchantA), name: 'Shop', profileImage: '/images/shop.png' });
  assert.equal(JSON.stringify(res.body).includes('private@example.test'), false);
});

test('public merchant stories include merchant identity and null profileImage when Vendor mapping is absent or ambiguous', async () => {
  const rows = [
    { _id: storyId, merchant: merchantA, mediaType: 'image', mediaUrl: 'u', createdAt: new Date(), expiresAt: new Date(Date.now() + 1000), viewsCount: 0 },
    { _id: new mongoose.Types.ObjectId(), merchant: merchantB, mediaType: 'image', mediaUrl: 'u2', createdAt: new Date(), expiresAt: new Date(Date.now() + 1000), viewsCount: 0 },
  ];
  const controller = createStoryController({
    StoryModel: { find: (filter) => findQuery(rows.filter((row) => !filter.merchant || String(row.merchant) === String(filter.merchant))) },
    MerchantModel: { find: () => ({ select() { return this; }, lean: async () => [
      { _id: merchantA, name: 'No Store' }, { _id: merchantB, name: 'Ambiguous Store' },
    ] }) },
    VendorModel: {
      publicMarketplaceFilter: () => ({ approvalStatus: 'approved', status: 'active' }),
      find(filter) {
        const isEligibleQuery = Object.hasOwn(filter, 'approvalStatus');
        const linked = [
          { _id: 'vendor-a', merchantId: merchantB },
          { _id: 'vendor-b', merchantId: merchantB },
        ];
        const eligible = [{ _id: 'vendor-a', merchantId: merchantB, logo: 'https://cdn.test/logo.png' }];
        return { select() { return this; }, lean: async () => isEligibleQuery ? eligible : linked };
      },
    },
  });
  const res = await call(controller.active, { query: {} });
  assert.deepEqual(res.body.stories.map((story) => story.merchant), [
    { id: String(merchantA), name: 'No Store', profileImage: null },
    { id: String(merchantB), name: 'Ambiguous Store', profileImage: null },
  ]);
  const merchantFeed = await call(controller.merchantActive, { params: { merchantId: String(merchantA) }, query: {} });
  assert.deepEqual(merchantFeed.body.stories[0].merchant, { id: String(merchantA), name: 'No Store', profileImage: null });
});

test('merchant history is scoped to the authenticated merchant and includes expired records', async () => {
  const expired = { _id: storyId, merchant: merchantA, mediaType: 'image', mediaUrl: 'u', createdAt: new Date(), expiresAt: new Date(0), viewsCount: 0 };
  let filter;
  const controller = createStoryController({ StoryModel: { find(value) { filter = value; return findQuery([expired]); } } });
  const res = await call(controller.mine, { merchant: { _id: merchantA }, query: {} });
  assert.equal(String(filter.merchant), String(merchantA));
  assert.equal(Object.hasOwn(filter, 'expiresAt'), false);
  assert.equal(res.body.stories.length, 1);
});

test('specific merchant active endpoint validates a Merchant ObjectId and applies active filtering', async () => {
  let filter;
  const controller = createStoryController({ StoryModel: { find(value) { filter = value; return findQuery([]); } } });
  const invalid = await call(controller.merchantActive, { params: { merchantId: 'vendor1' }, query: {} });
  assert.equal(invalid.statusCode, 400);
  await call(controller.merchantActive, { params: { merchantId: String(merchantB) }, query: {} });
  assert.equal(String(filter.merchant), String(merchantB));
  assert.ok(filter.expiresAt.$gt);
});

test('story deletion query includes authenticated owner and refuses another merchant', async () => {
  let filter;
  const controller = createStoryController({ StoryModel: { findOneAndDelete(value) { filter = value; return { lean: async () => null }; } } });
  const res = await call(controller.remove, { params: { storyId: String(storyId) }, merchant: { _id: merchantA } });
  assert.equal(res.statusCode, 404);
  assert.equal(String(filter.merchant), String(merchantA));
});

test('each valid opening increments atomically and expired stories cannot gain views', async () => {
  let calls = 0;
  const controller = createStoryController({ now: () => new Date('2026-01-01'), StoryModel: {
    findOneAndUpdate(filter, update) {
      calls += 1;
      assert.ok(filter.expiresAt.$gt);
      assert.equal(update.$inc.viewsCount, 1);
      return { lean: async () => calls < 3 ? { viewsCount: calls } : null };
    },
  } });
  assert.equal((await call(controller.view, { params: { storyId: String(storyId) } })).body.viewsCount, 1);
  assert.equal((await call(controller.view, { params: { storyId: String(storyId) } })).body.viewsCount, 2);
  assert.equal((await call(controller.view, { params: { storyId: String(storyId) } })).statusCode, 404);
});

test('Cloudinary failure returns a safe error and does not create metadata', async () => {
  const cloudinary = fakeCloudinary({ fail: true });
  const controller = createStoryController({ cloudinary, StoryModel: { create: async () => assert.fail('must not create') }, logger: { warn() {} } });
  const res = await call(controller.publish, publishReq());
  assert.equal(res.statusCode, 502);
});

test('database creation failure attempts to remove the uploaded Cloudinary asset', async () => {
  const cloudinary = fakeCloudinary();
  const controller = createStoryController({ cloudinary, StoryModel: { create: async () => { throw new Error('db failed'); } }, logger: { error() {} } });
  const res = await call(controller.publish, publishReq());
  assert.equal(res.statusCode, 500);
  assert.equal(cloudinary.calls.deletes[0].publicId, 'stories/asset-1');
});

test('pagination rejects invalid or unbounded limits and caps queries', async () => {
  let query;
  const controller = createStoryController({ StoryModel: { find(value) { query = findQuery([]); return query; } } });
  const tooMany = await call(controller.active, { query: { limit: '51' } });
  assert.equal(tooMany.statusCode, 400);
  await call(controller.active, { query: { limit: '50' } });
  assert.equal(query.limitValue, 51);
});

test('view endpoint has an explicit rate limiter in the route stack', () => {
  const pass = (_req, _res, next) => next();
  const controller = Object.fromEntries(['publish', 'active', 'mine', 'merchantActive', 'view', 'remove'].map((name) => [name, () => {}]));
  const router = createStoriesRouter({ protect: pass, controller, viewRateLimit: pass });
  const view = router.stack.find((layer) => layer.route?.path === '/:storyId/views').route.stack;
  assert.equal(view[0].handle, pass);
  assert.equal(view[1].handle, controller.view);
});

