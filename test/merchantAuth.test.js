const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const argon2 = require('argon2');
const Merchant = require('../models/Merchant');
const MerchantSession = require('../models/MerchantSession');
const { createProtectMerchant } = require('../middleware/protectMerchant');
const { createMerchantAuthRouter, SESSION_AGE_MS, cookieOptions, DUMMY_PASSWORD_HASH } = require('../routes/merchantAuth');

const NOW = new Date('2026-01-01T00:00:00.000Z');
const PASS = 'correct-horse-battery-42';
const passThrough = (_req, _res, next) => next();

function createModels({ merchantCreateError, merchantCreateErrors = [], counterInitialized = true, sessionCreateError, deleteError } = {}) {
  const merchants = [];
  const sessions = [];
  let nextId = 1;
  let counterValue = 0;
  const MerchantModel = {
    async create(data) {
      if (merchantCreateError) throw merchantCreateError;
      if (merchantCreateErrors.length) throw merchantCreateErrors.shift();
      if (merchants.some((item) => item.email === data.email || item.phone === data.phone)) {
        const duplicateField = merchants.some((item) => item.email === data.email) ? 'email' : 'phone';
        throw Object.assign(new Error('duplicate'), { code: 11000, keyPattern: { [duplicateField]: 1 }, keyValue: { [duplicateField]: data[duplicateField] } });
      }
      const merchant = { _id: `merchant-${nextId++}`, ...data, createdAt: NOW, updatedAt: NOW, async save() { this.updatedAt = NOW; } };
      merchants.push(merchant);
      return merchant;
    },
    async deleteOne({ _id }) {
      if (deleteError) throw deleteError;
      const index = merchants.findIndex((item) => item._id === _id);
      if (index >= 0) merchants.splice(index, 1);
      return { deletedCount: index >= 0 ? 1 : 0 };
    },
    findOne(filter) {
      const merchant = merchants.find((item) => Object.entries(filter).every(([key, value]) => item[key] === value)) || null;
      return { select: async () => merchant };
    },
    findById(id) {
      const merchant = merchants.find((item) => item._id === String(id));
      return { select() { return this; }, then(resolve, reject) { return Promise.resolve(merchant).then(resolve, reject); }, lean: async () => merchant ? ({
        _id: merchant._id, name: merchant.name, email: merchant.email, phone: merchant.phone,
        profileImage: merchant.profileImage, merchantId: merchant.merchantId, createdAt: merchant.createdAt, updatedAt: merchant.updatedAt,
      }) : null };
    },
    findOneAndUpdate(filter, update) {
      return { select: async () => {
        const merchant = merchants.find((item) => item._id === String(filter._id));
        if (!merchant) return null;
        if (merchants.some((item) => item !== merchant && update.$set.email && item.email === update.$set.email)) {
          throw Object.assign(new Error('duplicate email'), { code: 11000, keyPattern: { email: 1 }, keyValue: { email: update.$set.email } });
        }
        Object.assign(merchant, update.$set);
        return merchant;
      } };
    },
  };
  const MerchantCounterModel = {
    async allocateNextMerchantId() {
      if (!counterInitialized) return null;
      counterValue += 1;
      return String(counterValue).padStart(5, '0');
    },
  };
  const MerchantSessionModel = {
    MAX_SESSION_AGE_MS: SESSION_AGE_MS,
    async create(data) {
      if (sessionCreateError) throw sessionCreateError;
      const session = { _id: `session-${nextId++}`, ...data };
      sessions.push(session);
      return session;
    },
    findOne(filter) {
      const session = sessions.find((item) => Object.entries(filter).every(([key, value]) => {
        if (key === 'expiresAt') return item.expiresAt > value.$gt;
        return item[key] === value;
      })) || null;
      return { select: async () => session };
    },
    async updateOne(filter, update) {
      const session = sessions.find((item) => Object.entries(filter).every(([key, value]) => item[key] === value));
      if (session) Object.assign(session, update.$set);
    },
    async updateMany(filter, update) {
      for (const session of sessions) {
        if (session.merchant === filter.merchant && session._id !== filter._id.$ne && session.revokedAt === filter.revokedAt) Object.assign(session, update.$set);
      }
    },
  };
  return { MerchantModel, MerchantCounterModel, MerchantSessionModel, merchants, sessions };
}

function response() {
  return {
    statusCode: 200,
    body: undefined,
    cookies: {},
    clearedCookies: [],
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
    cookie(name, value, options) { this.cookies[name] = { value, options }; return this; },
    clearCookie(name, options) { this.clearedCookies.push({ name, options }); return this; },
  };
}

function makeRequest({ body = {}, cookies = {} } = {}) {
  return {
    body, cookies, params: {}, query: {}, headers: {}, method: 'POST',
    url: '/', originalUrl: '/', path: '/', ip: '127.0.0.1',
    socket: { remoteAddress: '127.0.0.1' },
    get(name) { return this.headers[name.toLowerCase()]; },
    header(name) { return this.get(name); },
  };
}

async function callRoute(router, routePath, method, req, res = response()) {
  const routeLayer = router.stack.find((layer) => layer.route?.path === routePath && layer.route.methods[method]);
  assert.ok(routeLayer, `Expected ${method.toUpperCase()} ${routePath}`);
  const handlers = routeLayer.route.stack.map((layer) => layer.handle);
  let forwardedError;
  const dispatch = async (index) => {
    if (index >= handlers.length || res.body !== undefined) return;
    let nextCalled = false;
    let nextPromise;
    const next = (error) => {
      if (error) { forwardedError = error; return; }
      nextCalled = true;
      nextPromise = dispatch(index + 1);
    };
    await handlers[index](req, res, next);
    if (nextCalled) await nextPromise;
  };
  await dispatch(0);
  if (forwardedError) throw forwardedError;
  return res;
}

function makeRouter(models, overrides = {}) {
  return createMerchantAuthRouter({
    ...models,
    argon2Module: argon2,
    registrationRateLimit: passThrough,
    loginRateLimit: passThrough,
    now: () => new Date(NOW),
    randomBytes: () => Buffer.from('0123456789abcdef0123456789abcdef', 'hex'),
    nodeEnv: 'development',
    logger: { error() {} },
    ...overrides,
  });
}

async function register(router, body) {
  return callRoute(router, '/register', 'post', makeRequest({ body }));
}

test('registration stores an Argon2id hash and only returns a safe profile', async () => {
  const models = createModels();
  const res = await register(makeRouter(models), {
    name: '  Demo Merchant ', email: ' SHOP@Example.com ', phone: '+1 (202) 555-0134', password: PASS,
  });
  assert.equal(res.statusCode, 201);
  assert.equal(models.merchants[0].name, 'Demo Merchant');
  assert.equal(models.merchants[0].email, 'shop@example.com');
  assert.equal(models.merchants[0].phone, '+12025550134');
  assert.equal(models.merchants[0].merchantId, '00001');
  assert.equal(res.body.merchant.merchantId, '00001');
  assert.match(models.merchants[0].passwordHash, /^\$argon2id\$/);
  assert.equal(await argon2.verify(models.merchants[0].passwordHash, PASS), true);
  assert.equal(Object.hasOwn(res.body.merchant, 'passwordHash'), false);
  assert.equal(Object.hasOwn(models.merchants[0], 'password'), false);
  assert.equal(res.cookies.merchantToken.options.maxAge, SESSION_AGE_MS);
  assert.deepEqual({ httpOnly: res.cookies.merchantToken.options.httpOnly, secure: res.cookies.merchantToken.options.secure, sameSite: res.cookies.merchantToken.options.sameSite },
    { httpOnly: true, secure: false, sameSite: 'lax' });
});

test('merchant IDs are sequential, retain leading zeroes, and expand to six digits', async () => {
  const models = createModels();
  const router = makeRouter(models);
  const profiles = [];
  for (let i = 1; i <= 3; i += 1) {
    const res = await register(router, {
      name: `Merchant ${i}`, email: `m${i}@example.com`, phone: `+1202555011${i}`, password: PASS,
    });
    profiles.push(res.body.merchant.merchantId);
  }
  assert.deepEqual(profiles, ['00001', '00002', '00003']);

  let value = 99998;
  models.MerchantCounterModel.allocateNextMerchantId = async () => {
    value += 1;
    return String(value).padStart(5, '0');
  };
  const fiveDigits = await register(router, {
    name: 'Merchant 4', email: 'm4@example.com', phone: '+12025550114', password: PASS,
  });
  const sixDigits = await register(router, {
    name: 'Merchant 5', email: 'm5@example.com', phone: '+12025550115', password: PASS,
  });
  assert.equal(fiveDigits.body.merchant.merchantId, '99999');
  assert.equal(sixDigits.body.merchant.merchantId, '100000');
});

test('concurrent registrations receive distinct sequential merchant IDs', async () => {
  const models = createModels();
  const router = makeRouter(models);
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => register(router, {
    name: `Merchant ${i}`, email: `parallel${i}@example.com`, phone: `+12025550${String(i).padStart(4, '0')}`, password: PASS,
  })));
  const ids = results.map((res) => res.body.merchant.merchantId).sort();
  assert.deepEqual(ids, Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(5, '0')));
});

test('client-supplied merchantId is ignored', async () => {
  const models = createModels();
  const res = await register(makeRouter(models), {
    name: 'Merchant A', email: 'a@example.com', phone: '+12025550111', password: PASS, merchantId: '77777',
  });
  assert.equal(res.statusCode, 201);
  assert.equal(models.merchants[0].merchantId, '00001');
  assert.equal(res.body.merchant.merchantId, '00001');
});

test('registration is gated until the legacy merchant ID migration initializes the counter', async () => {
  const models = createModels({ counterInitialized: false });
  const res = await register(makeRouter(models), {
    name: 'Merchant A', email: 'a@example.com', phone: '+12025550111', password: PASS,
  });
  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.body, { message: 'Merchant registration is temporarily unavailable' });
  assert.equal(models.merchants.length, 0);
});

test('failed account creation burns the allocation and a retry succeeds with the next ID', async () => {
  const models = createModels({ merchantCreateErrors: [Object.assign(new Error('temporary failure'), { code: 'WRITE_FAILED' })] });
  const router = makeRouter(models);
  const body = { name: 'Merchant A', email: 'a@example.com', phone: '+12025550111', password: PASS };
  const failed = await register(router, body);
  const retry = await register(router, body);
  assert.equal(failed.statusCode, 500);
  assert.deepEqual(failed.body, { message: 'Registration failed' });
  assert.equal(retry.statusCode, 201);
  assert.equal(retry.body.merchant.merchantId, '00002');
});

test('a Merchant ID duplicate retries allocation while email and phone duplicates remain conflicts', async () => {
  const models = createModels({ merchantCreateErrors: [Object.assign(new Error('duplicate merchant ID'), {
    code: 11000, keyPattern: { merchantId: 1 }, keyValue: { merchantId: '00001' },
  })] });
  const res = await register(makeRouter(models), {
    name: 'Merchant A', email: 'a@example.com', phone: '+12025550111', password: PASS,
  });
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.merchant.merchantId, '00002');
});

test('registration rejects duplicate email and phone with 409', async (t) => {
  for (const duplicate of ['email', 'phone']) await t.test(`duplicate ${duplicate}`, async () => {
    const models = createModels();
    const router = makeRouter(models);
    const base = { name: 'Merchant A', email: 'a@example.com', phone: '+12025550111', password: PASS };
    assert.equal((await register(router, base)).statusCode, 201);
    const second = { name: 'Merchant B', email: 'b@example.com', phone: '+12025550112', password: PASS };
    second[duplicate] = base[duplicate];
    assert.equal((await register(router, second)).statusCode, 409);
  });
});

test('registration maps only email or phone duplicate-key errors to 409', async (t) => {
  for (const field of ['email', 'phone']) await t.test(field, async () => {
    const models = createModels({
      merchantCreateError: Object.assign(new Error('duplicate key'), {
        code: 11000, keyPattern: { [field]: 1 }, keyValue: { [field]: 'private-identifier' },
      }),
    });
    const res = await register(makeRouter(models), {
      name: 'Merchant A', email: 'a@example.com', phone: '+12025550111', password: PASS,
    });
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.message, 'Email or phone number is already registered');
    assert.equal(models.merchants.length, 0);
  });
});

test('session creation failure cleans up the new account and returns a generic server error', async () => {
  const models = createModels({ sessionCreateError: Object.assign(new Error('sensitive database detail'), { code: 'SESSION_WRITE_FAILED' }) });
  const logs = [];
  const res = await register(makeRouter(models, { logger: { error: (...args) => logs.push(args) } }), {
    name: 'Merchant A', email: 'a@example.com', phone: '+12025550111', password: PASS,
  });
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, { message: 'Registration failed' });
  assert.equal(models.merchants.length, 0);
  assert.equal(models.sessions.length, 0);
  assert.equal(JSON.stringify(logs).includes('sensitive database detail'), false);
});

test('session duplicate-key failure is not reported as a duplicate merchant identifier', async () => {
  const models = createModels({
    sessionCreateError: Object.assign(new Error('duplicate session key'), {
      code: 11000, keyPattern: { tokenHash: 1 },
    }),
  });
  const res = await register(makeRouter(models), {
    name: 'Merchant A', email: 'a@example.com', phone: '+12025550111', password: PASS,
  });
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, { message: 'Registration failed' });
  assert.equal(models.merchants.length, 0);
});

test('cleanup failure after session creation failure remains a safe server error', async () => {
  const models = createModels({
    sessionCreateError: Object.assign(new Error('private session error'), { code: 'SESSION_WRITE_FAILED' }),
    deleteError: Object.assign(new Error('private cleanup error'), { code: 'CLEANUP_FAILED' }),
  });
  const logs = [];
  const res = await register(makeRouter(models, { logger: { error: (...args) => logs.push(args) } }), {
    name: 'Merchant A', email: 'a@example.com', phone: '+12025550111', password: PASS,
  });
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, { message: 'Registration failed' });
  assert.equal(models.merchants.length, 1);
  assert.equal(JSON.stringify(logs).includes('private session error'), false);
  assert.equal(JSON.stringify(logs).includes('private cleanup error'), false);
});

test('login accepts email and phone and uses the same generic error for unknown and wrong credentials', async (t) => {
  const models = createModels();
  const router = makeRouter(models);
  await register(router, { name: 'Merchant A', email: 'a@example.com', phone: '+12025550111', password: PASS });
  for (const identifier of ['A@Example.com', '+1 (202) 555-0111']) await t.test(`login ${identifier}`, async () => {
    const res = await callRoute(router, '/login', 'post', makeRequest({ body: { identifier, password: PASS } }));
    assert.equal(res.statusCode, 200);
    assert.ok(res.cookies.merchantToken);
    assert.equal(res.body.merchant.merchantId, '00001');
    assert.equal(Object.hasOwn(res.body.merchant, 'passwordHash'), false);
  });
  const wrong = await callRoute(router, '/login', 'post', makeRequest({ body: { identifier: 'a@example.com', password: 'incorrect-password' } }));
  const unknown = await callRoute(router, '/login', 'post', makeRequest({ body: { identifier: 'missing@example.com', password: PASS } }));
  assert.equal(wrong.statusCode, 401);
  assert.equal(unknown.statusCode, 401);
  assert.deepEqual(wrong.body, unknown.body);
});

test('unknown identifier performs a dummy Argon2id verification', async () => {
  const models = createModels();
  const verifications = [];
  const argon2Spy = {
    argon2id: argon2.argon2id,
    hash: (...args) => argon2.hash(...args),
    verify: async (hash, password) => {
      verifications.push({ hash, password });
      return argon2.verify(hash, password);
    },
  };
  const router = makeRouter(models, { argon2Module: argon2Spy });
  const res = await callRoute(router, '/login', 'post', makeRequest({
    body: { identifier: 'missing@example.com', password: PASS },
  }));
  assert.equal(res.statusCode, 401);
  assert.equal(verifications.length, 1);
  assert.equal(verifications[0].hash, DUMMY_PASSWORD_HASH);
  assert.equal(DUMMY_PASSWORD_HASH.startsWith('$argon2id$'), true);
});

test('registration persists only a hash of the random session token', async () => {
  const models = createModels();
  const res = await register(makeRouter(models), {
    name: 'Merchant A', email: 'a@example.com', phone: '+12025550111', password: PASS,
  });
  const rawToken = res.cookies.merchantToken.value;
  assert.equal(models.sessions.length, 1);
  assert.equal(models.sessions[0].tokenHash, crypto.createHash('sha256').update(rawToken).digest('hex'));
  assert.equal(JSON.stringify(models.sessions[0]).includes(rawToken), false);
  assert.equal(models.sessions[0].expiresAt.getTime() - models.sessions[0].createdAt.getTime(), SESSION_AGE_MS);
});

test('merchant middleware validates active sessions and rejects customer/admin cookies', async (t) => {
  const rawToken = 'merchant-test-token';
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const merchant = { _id: 'merchant-1', name: 'Merchant', email: 'm@example.com', phone: '+12025550111', merchantId: '00001', createdAt: NOW, updatedAt: NOW };
  let session = { _id: 'session-1', merchant: merchant._id, tokenHash, createdAt: NOW, expiresAt: new Date(NOW.getTime() + SESSION_AGE_MS), revokedAt: null };
  let selectedSessionFields;
  let selectedMerchantFields;
  const sessionModel = { MAX_SESSION_AGE_MS: SESSION_AGE_MS, findOne: (filter) => ({ select: async (projection) => {
    selectedSessionFields = projection;
    if (filter.tokenHash !== tokenHash) return null;
    if (session?.revokedAt !== null || session?.expiresAt <= filter.expiresAt.$gt) return null;
    return session;
  } }) };
  const merchantModel = { findById: () => ({ select(fields) { selectedMerchantFields = fields; return this; }, lean: async () => merchant }) };
  const protect = createProtectMerchant({ MerchantModel: merchantModel, MerchantSessionModel: sessionModel, now: () => new Date(NOW) });
  const invoke = async (cookies) => {
    const res = response();
    let nextCalled = false;
    const req = makeRequest({ cookies });
    await protect(req, res, (err) => { if (err) throw err; nextCalled = true; });
    return { res, req, nextCalled };
  };
  const good = await invoke({ merchantToken: rawToken });
  assert.equal(good.nextCalled, true);
  assert.equal(good.req.merchantSessionId, 'session-1');
  assert.equal(good.req.merchant.merchantId, '00001');
  assert.match(selectedMerchantFields, /merchantId/);
  assert.equal(selectedSessionFields, '_id merchant createdAt expiresAt');
  assert.equal(Object.hasOwn(good.req, 'merchantSession'), false);
  await t.test('missing token', async () => assert.equal((await invoke({})).res.statusCode, 401));
  await t.test('customer/admin tokens are not accepted', async () => {
    assert.equal((await invoke({ token: rawToken })).res.statusCode, 401);
    assert.equal((await invoke({ adminToken: rawToken })).res.statusCode, 401);
  });
  await t.test('invalid token', async () => assert.equal((await invoke({ merchantToken: 'invalid' })).res.statusCode, 401));
  await t.test('expired session', async () => {
    session = { ...session, expiresAt: new Date(NOW.getTime() - 1) };
    assert.equal((await invoke({ merchantToken: rawToken })).res.statusCode, 401);
    session = { ...session, expiresAt: new Date(NOW.getTime() + SESSION_AGE_MS) };
  });
  await t.test('revoked session', async () => {
    session = { ...session, revokedAt: NOW };
    assert.equal((await invoke({ merchantToken: rawToken })).res.statusCode, 401);
  });
});

test('session endpoint returns merchantId but excludes sensitive fields', async () => {
  const models = createModels();
  const res = await callRoute(makeRouter(models, { protect: (_req, _res, next) => next() }), '/me', 'get', Object.assign(makeRequest(), {
    merchant: { _id: 'merchant-1', name: 'Merchant', email: 'm@example.com', phone: '+12025550111', profileImage: '/api/images/avatar.png', merchantId: '00042', passwordHash: 'secret-hash', internalFlag: true },
  }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.merchant.merchantId, '00042');
  assert.equal(res.body.merchant.name, 'Merchant');
  assert.equal(res.body.merchant.email, 'm@example.com');
  assert.equal(res.body.merchant.phone, '+12025550111');
  assert.equal(res.body.merchant.profileImage, '/api/images/avatar.png');
  assert.deepEqual(res.body.merchant.verification, { status: 'not_configured', verified: false });
  assert.equal(Object.hasOwn(res.body.merchant, 'passwordHash'), false);
  assert.equal(Object.hasOwn(res.body.merchant, 'internalFlag'), false);
});

test('logout revokes the current session and clears matching cookie attributes; repeated logout succeeds', async () => {
  const models = createModels();
  const router = makeRouter(models);
  const created = await register(router, { name: 'Merchant A', email: 'a@example.com', phone: '+12025550111', password: PASS });
  const token = created.cookies.merchantToken.value;
  const req = makeRequest({ cookies: { merchantToken: token } });
  const first = await callRoute(router, '/logout', 'post', req);
  assert.ok(models.sessions[0].revokedAt instanceof Date);
  assert.equal(first.clearedCookies[0].name, 'merchantToken');
  assert.deepEqual(first.clearedCookies[0].options, { httpOnly: true, secure: false, sameSite: 'lax', path: '/' });
  assert.equal((await callRoute(router, '/logout', 'post', req)).statusCode, 200);
});

test('cookie settings use seven days and secure cross-site attributes in production', () => {
  assert.deepEqual(cookieOptions('production'), {
    httpOnly: true, secure: true, sameSite: 'none', path: '/', maxAge: SESSION_AGE_MS,
  });
  assert.equal(SESSION_AGE_MS, 7 * 24 * 60 * 60 * 1000);
});

test('invalid registration inputs are rejected before creating an account', async () => {
  const models = createModels();
  const res = await register(makeRouter(models), {
    name: 'x', email: 'not-an-email', phone: '123', password: 'short',
  });
  assert.equal(res.statusCode, 400);
  assert.equal(models.merchants.length, 0);
  assert.equal(models.sessions.length, 0);
});

test('session schema rejects lifetimes beyond seven days without a database connection', async () => {
  const session = new MerchantSession({
    merchant: new (require('mongoose').Types.ObjectId)(),
    tokenHash: 'a'.repeat(64),
    createdAt: NOW,
    expiresAt: new Date(NOW.getTime() + SESSION_AGE_MS + 1),
  });
  await assert.rejects(session.validate(), /cannot last longer than seven days/);
});

test('merchant model normalizes email and phone and omits password hashes from serialization', () => {
  const merchant = new Merchant({ name: 'Shop', email: ' SHOP@EXAMPLE.COM ', phone: '+1 (202) 555-0111', passwordHash: 'hash' });
  assert.equal(merchant.email, 'shop@example.com');
  assert.equal(merchant.phone, '+12025550111');
  assert.equal(Object.hasOwn(merchant.toJSON(), 'passwordHash'), false);
});

test('merchant schema rejects plaintext in the password hash field', async () => {
  const merchant = new Merchant({
    name: 'Shop', email: 'shop@example.com', phone: '+12025550111', passwordHash: 'plaintext-password',
  });
  await assert.rejects(merchant.validate(), /Argon2id hash/);
});

test('existing merchants without merchantId remain valid until migration assigns one', async () => {
  const merchant = new Merchant({
    name: 'Legacy Shop', email: 'legacy@example.com', phone: '+12025550111', passwordHash: '$argon2id$legacy',
  });
  await assert.doesNotReject(merchant.validate());
  assert.equal(merchant.merchantId, undefined);
});

test('profile update allowlists fields, normalizes identifiers, and returns safe current merchant data', async () => {
  const models = createModels();
  const router = makeRouter(models, { protect: passThrough });
  await register(router, { name: 'Merchant A', email: 'a@example.com', phone: '+12025550111', password: PASS });
  const req = makeRequest({ body: { name: '  Updated Merchant ', email: ' UPDATED@Example.com ', phone: '+1 (202) 555-0199' } });
  req.merchant = models.merchants[0];
  const result = await callRoute(router, '/profile', 'put', req);
  assert.equal(result.statusCode, 200);
  assert.equal(models.merchants[0].name, 'Updated Merchant');
  assert.equal(models.merchants[0].email, 'updated@example.com');
  assert.equal(models.merchants[0].phone, '+12025550199');
  assert.deepEqual(result.body.merchant.verification, { status: 'not_configured', verified: false });
  assert.equal(Object.hasOwn(result.body.merchant, 'passwordHash'), false);
  const forbidden = await callRoute(router, '/profile', 'put', Object.assign(makeRequest({ body: { merchantId: '99999' } }), { merchant: models.merchants[0] }));
  assert.equal(forbidden.statusCode, 400);
});

test('profile update stops at merchant authentication when no valid session is present', async () => {
  const models = createModels();
  const unauthorizedProtect = (_req, res) => res.status(401).json({ message: 'Merchant not authenticated' });
  const router = makeRouter(models, { protect: unauthorizedProtect });
  const result = await callRoute(router, '/profile', 'put', makeRequest({ body: { name: 'Intruder' } }));
  assert.equal(result.statusCode, 401);
  assert.equal(models.merchants.length, 0);
});

test('profile update rejects duplicate email and invalid phone without changing the account', async () => {
  const models = createModels();
  const router = makeRouter(models, { protect: passThrough });
  await register(router, { name: 'Merchant A', email: 'a@example.com', phone: '+12025550111', password: PASS });
  await register(router, { name: 'Merchant B', email: 'b@example.com', phone: '+12025550112', password: PASS });
  const duplicate = await callRoute(router, '/profile', 'put', Object.assign(makeRequest({ body: { email: 'B@EXAMPLE.COM' } }), { merchant: models.merchants[0] }));
  assert.equal(duplicate.statusCode, 409);
  const invalid = await callRoute(router, '/profile', 'put', Object.assign(makeRequest({ body: { phone: 'not a phone' } }), { merchant: models.merchants[0] }));
  assert.equal(invalid.statusCode, 400);
  assert.equal(models.merchants[0].email, 'a@example.com');
});

test('profile image accepts only a merchant-owned uploaded image reference', async () => {
  const models = createModels();
  const filename = '123e4567-e89b-12d3-a456-426614174000.png';
  const router = makeRouter({ ...models, ImageModel: {
    findOne(filter) { return { select() { return this; }, lean: async () => filter.ownerId === models.merchants[0]._id ? { _id: 'image-1' } : null }; },
  } }, { protect: passThrough });
  await register(router, { name: 'Merchant A', email: 'a@example.com', phone: '+12025550111', password: PASS });
  const own = await callRoute(router, '/profile', 'put', Object.assign(makeRequest({ body: { profileImage: `/api/images/${filename}` } }), { merchant: models.merchants[0] }));
  assert.equal(own.statusCode, 200);
  assert.equal(models.merchants[0].profileImage, `/api/images/${filename}`);
  const external = await callRoute(router, '/profile', 'put', Object.assign(makeRequest({ body: { profileImage: 'https://example.com/avatar.png' } }), { merchant: models.merchants[0] }));
  assert.equal(external.statusCode, 400);
});

test('password change uses Argon2id, rejects a wrong current password, and revokes only other sessions', async () => {
  const models = createModels();
  const router = makeRouter(models, { protect: passThrough });
  await register(router, { name: 'Merchant A', email: 'a@example.com', phone: '+12025550111', password: PASS });
  const merchant = models.merchants[0];
  models.sessions.push({ _id: 'session-current', merchant: merchant._id, revokedAt: null }, { _id: 'session-other', merchant: merchant._id, revokedAt: null });
  const wrong = await callRoute(router, '/change-password', 'put', Object.assign(makeRequest({ body: { currentPassword: 'wrong-password', newPassword: 'new-secure-password' } }), { merchant, merchantSessionId: 'session-current' }));
  assert.equal(wrong.statusCode, 401);
  assert.equal(await argon2.verify(merchant.passwordHash, PASS), true);
  const invalid = await callRoute(router, '/change-password', 'put', Object.assign(makeRequest({ body: { currentPassword: PASS, newPassword: 'short' } }), { merchant, merchantSessionId: 'session-current' }));
  assert.equal(invalid.statusCode, 400);
  const changed = await callRoute(router, '/change-password', 'put', Object.assign(makeRequest({ body: { currentPassword: PASS, newPassword: 'new-secure-password' } }), { merchant, merchantSessionId: 'session-current' }));
  assert.equal(changed.statusCode, 200);
  assert.equal(await argon2.verify(merchant.passwordHash, 'new-secure-password'), true);
  assert.equal(models.sessions.find((session) => session._id === 'session-current').revokedAt, null);
  assert.ok(models.sessions.find((session) => session._id === 'session-other').revokedAt instanceof Date);
  assert.equal(JSON.stringify(changed.body).includes(merchant.passwordHash), false);
});

test('schema declares the required unique and expiry indexes without database operations', () => {
  const declared = (model) => model.schema.indexes();
  const hasIndex = (indexes, fields, predicate) => indexes.some(([key, options]) =>
    JSON.stringify(key) === JSON.stringify(fields) && predicate(options));
  const merchantIndexes = declared(Merchant);
  const sessionIndexes = declared(MerchantSession);
  assert.equal(hasIndex(merchantIndexes, { email: 1 }, (options) => options.unique === true), true);
  assert.equal(hasIndex(merchantIndexes, { phone: 1 }, (options) => options.unique === true), true);
  assert.equal(Merchant.schema.path('merchantId').options.immutable, true);
  assert.equal(hasIndex(merchantIndexes, { merchantId: 1 }, (options) =>
    options.unique === true && options.partialFilterExpression?.merchantId?.$type === 'string'), true);
  assert.equal(hasIndex(sessionIndexes, { tokenHash: 1 }, (options) => options.unique === true), true);
  assert.equal(hasIndex(sessionIndexes, { expiresAt: 1 }, (options) => options.expireAfterSeconds === 0), true);
  assert.equal(hasIndex(sessionIndexes, { merchant: 1 }, (options) => options.background !== false), true);
  assert.equal(hasIndex(sessionIndexes, { merchant: 1, expiresAt: 1 }, (options) => options.background !== false), true);
});
