const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const argon2 = require('argon2');
const Affiliate = require('../models/Affiliate');
const AffiliateSession = require('../models/AffiliateSession');
const { createProtectAffiliate } = require('../middleware/protectAffiliate');
const { createAffiliateAuthRouter, SESSION_AGE_MS, cookieOptions } = require('../routes/affiliateAuth');

const NOW = new Date('2026-01-01T00:00:00.000Z');
const PASSWORD = 'correct-horse-battery-42';
const passThrough = (_req, _res, next) => next();

function createModels() {
  const affiliates = [];
  const sessions = [];
  let nextId = 1;
  const AffiliateModel = {
    async create(data) {
      if (affiliates.some((item) => item.email === data.email)) {
        throw Object.assign(new Error('duplicate'), { code: 11000, keyPattern: { email: 1 }, keyValue: { email: data.email } });
      }
      const affiliate = { _id: `affiliate-${nextId++}`, ...data, createdAt: NOW, updatedAt: NOW, async save() {} };
      affiliates.push(affiliate);
      return affiliate;
    },
    findOne(filter) {
      const affiliate = affiliates.find((item) => Object.entries(filter).every(([key, value]) => item[key] === value)) || null;
      return { select: async () => affiliate };
    },
    findById(id) {
      const affiliate = affiliates.find((item) => item._id === String(id));
      return { select() { return this; }, lean: async () => affiliate || null };
    },
    async findOneAndUpdate(filter, update) {
      const affiliate = affiliates.find((item) => item._id === String(filter._id));
      if (!affiliate) return null;
      Object.assign(affiliate, update.$set, { updatedAt: new Date(NOW.getTime() + 1) });
      return affiliate;
    },
    async deleteOne({ _id }) {
      const index = affiliates.findIndex((item) => item._id === _id);
      if (index >= 0) affiliates.splice(index, 1);
      return { deletedCount: index >= 0 ? 1 : 0 };
    },
  };
  const AffiliateSessionModel = {
    MAX_SESSION_AGE_MS: SESSION_AGE_MS,
    async create(data) { const session = { _id: `session-${nextId++}`, ...data }; sessions.push(session); return session; },
    findOne(filter) {
      const session = sessions.find((item) => item.tokenHash === filter.tokenHash && item.revokedAt === null && item.expiresAt > filter.expiresAt.$gt) || null;
      return { select: async () => session };
    },
    async updateOne(filter, update) {
      const session = sessions.find((item) => item.tokenHash === filter.tokenHash && item.revokedAt === null);
      if (session) Object.assign(session, update.$set);
    },
    async updateMany(filter, update) {
      for (const session of sessions) if (session.affiliate === filter.affiliate && session.revokedAt === null) Object.assign(session, update.$set);
    },
  };
  return { AffiliateModel, AffiliateSessionModel, affiliates, sessions };
}

function response() {
  return {
    statusCode: 200, body: undefined, cookies: {}, clearedCookies: [],
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
    cookie(name, value, options) { this.cookies[name] = { value, options }; return this; },
    clearCookie(name, options) { this.clearedCookies.push({ name, options }); return this; },
  };
}

function makeRequest({ body = {}, cookies = {}, method = 'POST', path = '/' } = {}) {
  return { body, cookies, params: {}, query: {}, headers: {}, method, url: path, originalUrl: path, path, ip: '127.0.0.1', socket: { remoteAddress: '127.0.0.1' }, get(name) { return this.headers[name.toLowerCase()]; }, header(name) { return this.get(name); } };
}

async function callRoute(router, routePath, method, req, res = response()) {
  const route = router.stack.find((layer) => layer.route?.path === routePath && layer.route.methods[method])?.route;
  assert.ok(route, `Expected ${method.toUpperCase()} ${routePath}`);
  const handlers = route.stack.map((layer) => layer.handle);
  let forwardedError;
  const dispatch = async (index) => {
    if (index >= handlers.length || res.body !== undefined) return;
    let nextCalled = false;
    let nextPromise;
    await handlers[index](req, res, (error) => {
      if (error) { forwardedError = error; return; }
      nextCalled = true;
      nextPromise = dispatch(index + 1);
    });
    if (nextCalled) await nextPromise;
  };
  await dispatch(0);
  if (forwardedError) throw forwardedError;
  return res;
}

function makeRouter(models) {
  return createAffiliateAuthRouter({
    ...models, argon2Module: argon2,
    protect: createProtectAffiliate({ ...models, now: () => new Date(NOW) }),
    email: { async sendPasswordResetEmail() {} },
    registrationRateLimit: passThrough, loginRateLimit: passThrough, recoveryRateLimit: passThrough,
    now: () => new Date(NOW), randomBytes: () => Buffer.from('0123456789abcdef0123456789abcdef', 'hex'),
    randomInt: () => 123456, nodeEnv: 'development', logger: { error() {} },
  });
}

async function register(router, body) {
  return callRoute(router, '/register', 'post', makeRequest({ body }));
}

test('Affiliate registration stores an independent Argon2id account and hashed session token', async () => {
  const models = createModels();
  const res = await register(makeRouter(models), { name: '  Demo Affiliate ', email: ' AFFILIATE@Example.com ', password: PASSWORD });
  assert.equal(res.statusCode, 201);
  assert.equal(models.affiliates.length, 1);
  assert.equal(models.affiliates[0].name, 'Demo Affiliate');
  assert.equal(models.affiliates[0].email, 'affiliate@example.com');
  assert.equal(models.affiliates[0].status, 'active');
  assert.match(models.affiliates[0].passwordHash, /^\$argon2id\$/);
  assert.equal(await argon2.verify(models.affiliates[0].passwordHash, PASSWORD), true);
  assert.equal(res.cookies.affiliateToken.options.maxAge, SESSION_AGE_MS);
  const token = res.cookies.affiliateToken.value;
  assert.equal(models.sessions[0].tokenHash, crypto.createHash('sha256').update(token).digest('hex'));
  assert.equal(JSON.stringify(models.sessions).includes(token), false);
  assert.equal(JSON.stringify(res.body).includes(token), false);
  assert.equal(JSON.stringify(res.body).includes(models.affiliates[0].passwordHash), false);
});

test('duplicate email and invalid registration are rejected', async () => {
  const models = createModels();
  const router = makeRouter(models);
  const body = { name: 'Affiliate A', email: 'same@example.com', password: PASSWORD };
  assert.equal((await register(router, body)).statusCode, 201);
  assert.equal((await register(router, { ...body, email: ' SAME@EXAMPLE.COM ' })).statusCode, 409);
  assert.equal((await register(router, { ...body, name: 'x', email: 'bad' })).statusCode, 400);
  assert.equal(models.affiliates.length, 1);
});

test('login and /me authenticate only through the Affiliate cookie and collection', async () => {
  const models = createModels();
  const router = makeRouter(models);
  await register(router, { name: 'Affiliate', email: 'a@example.com', password: PASSWORD });
  const login = await callRoute(router, '/login', 'post', makeRequest({ body: { email: 'A@Example.com', password: PASSWORD } }));
  assert.equal(login.statusCode, 200);
  assert.ok(login.cookies.affiliateToken);
  const raw = login.cookies.affiliateToken.value;

  const protect = createProtectAffiliate({ ...models, now: () => new Date(NOW) });
  const invoke = async (cookies) => {
    const req = makeRequest({ cookies });
    const res = response();
    let passed = false;
    await protect(req, res, () => { passed = true; });
    return { req, res, passed };
  };
  const valid = await invoke({ affiliateToken: raw });
  assert.equal(valid.passed, true);
  assert.equal(valid.req.affiliate.email, 'a@example.com');
  for (const cookies of [{}, { token: raw }, { merchantToken: raw }, { adminToken: raw }]) {
    assert.equal((await invoke(cookies)).res.statusCode, 401);
  }
  const meRouter = createAffiliateAuthRouter({
    ...models, protect: createProtectAffiliate({ ...models, now: () => new Date(NOW) }),
  });
  const authenticatedMe = await callRoute(meRouter, '/me', 'get', makeRequest({ cookies: { affiliateToken: raw } }));
  assert.equal(authenticatedMe.statusCode, 200);
  assert.equal(authenticatedMe.body.affiliate.email, 'a@example.com');
  const me = await callRoute(router, '/me', 'get', makeRequest());
  assert.equal(me.statusCode, 401);
  // Injected identity verifies the /me safe-profile response independently of MongoDB.
  const safeRouter = createAffiliateAuthRouter({ ...models, protect: (_req, _res, next) => next() });
  const safeMe = await callRoute(safeRouter, '/me', 'get', Object.assign(makeRequest(), { affiliate: { ...valid.req.affiliate, passwordHash: 'secret' } }));
  assert.equal(safeMe.body.affiliate.email, 'a@example.com');
  assert.equal(Object.hasOwn(safeMe.body.affiliate, 'passwordHash'), false);
});

test('authenticated /me returns the safe profile for the cookie owner', async () => {
  const models = createModels();
  const router = makeRouter(models);
  const created = await register(router, { name: 'Profile Affiliate', email: 'profile@example.com', phone: '+254712345678', password: PASSWORD });
  const result = await callRoute(router, '/me', 'get', makeRequest({ method: 'GET', path: '/me', cookies: { affiliateToken: created.cookies.affiliateToken.value } }));
  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.body.affiliate, {
    id: 'affiliate-1', name: 'Profile Affiliate', email: 'profile@example.com', phone: '+254712345678',
    status: 'active', createdAt: NOW, updatedAt: NOW,
  });
});

test('profile update rejects unauthenticated requests', async () => {
  const models = createModels();
  const router = makeRouter(models);
  const result = await callRoute(router, '/me', 'patch', makeRequest({ method: 'PATCH', path: '/me', body: { name: 'Updated Name' } }));
  assert.equal(result.statusCode, 401);
  assert.equal(models.affiliates.length, 0);
});

test('authenticated affiliate can update name and normalized phone only on their account', async () => {
  const models = createModels();
  const router = makeRouter(models);
  const created = await register(router, { name: 'First Affiliate', email: 'first@example.com', phone: '+254700000001', password: PASSWORD });
  const token = created.cookies.affiliateToken.value;
  const result = await callRoute(router, '/me', 'patch', makeRequest({ method: 'PATCH', path: '/me', cookies: { affiliateToken: token }, body: { name: '  Updated Name  ', phone: '+254 (712) 345-678' } }));
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.affiliate.id, 'affiliate-1');
  assert.equal(result.body.affiliate.name, 'Updated Name');
  assert.equal(result.body.affiliate.phone, '+254712345678');
  assert.equal(result.body.affiliate.email, 'first@example.com');
  assert.equal(models.affiliates[0].name, 'Updated Name');
  assert.equal(models.affiliates[0].phone, '+254712345678');
});

test('profile update rejects invalid names and phone values', async () => {
  const models = createModels();
  const router = makeRouter(models);
  const created = await register(router, { name: 'Profile Affiliate', email: 'profile@example.com', phone: '+254700000001', password: PASSWORD });
  const cookies = { affiliateToken: created.cookies.affiliateToken.value };
  for (const body of [{ name: ' ' }, { name: 'x'.repeat(101) }, { phone: 'not-a-phone' }, { phone: 712345678 }]) {
    const result = await callRoute(router, '/me', 'patch', makeRequest({ method: 'PATCH', path: '/me', cookies, body }));
    assert.equal(result.statusCode, 400, JSON.stringify(body));
  }
  assert.equal(models.affiliates[0].name, 'Profile Affiliate');
  assert.equal(models.affiliates[0].phone, '+254700000001');
});

test('profile update rejects protected fields and cannot target another affiliate', async () => {
  const models = createModels();
  const router = makeRouter(models);
  const first = await register(router, { name: 'First Affiliate', email: 'first@example.com', password: PASSWORD });
  await register(router, { name: 'Second Affiliate', email: 'second@example.com', password: PASSWORD });
  const cookies = { affiliateToken: first.cookies.affiliateToken.value };
  for (const field of ['email', 'status', 'affiliateId', 'id', 'passwordHash']) {
    const result = await callRoute(router, '/me', 'patch', makeRequest({ method: 'PATCH', path: '/me', cookies, body: { name: 'Should Not Save', [field]: 'affiliate-2' } }));
    assert.equal(result.statusCode, 400, field);
  }
  assert.equal(models.affiliates[0].name, 'First Affiliate');
  assert.equal(models.affiliates[1].name, 'Second Affiliate');
});

test('logout revokes the affiliate session and clears only affiliateToken', async () => {
  const models = createModels();
  const router = makeRouter(models);
  const created = await register(router, { name: 'Affiliate', email: 'a@example.com', password: PASSWORD });
  const token = created.cookies.affiliateToken.value;
  const res = await callRoute(router, '/logout', 'post', makeRequest({ cookies: { affiliateToken: token, merchantToken: 'leave-alone' } }));
  assert.ok(models.sessions[0].revokedAt instanceof Date);
  assert.deepEqual(res.clearedCookies.map((cookie) => cookie.name), ['affiliateToken']);
  const protect = createProtectAffiliate({ ...models, now: () => new Date(NOW) });
  const rejected = response();
  await protect(makeRequest({ cookies: { affiliateToken: token } }), rejected, () => assert.fail('revoked token accepted'));
  assert.equal(rejected.statusCode, 401);
  models.sessions[0].revokedAt = null;
  models.sessions[0].expiresAt = new Date(NOW.getTime() - 1);
  const expired = response();
  await protect(makeRequest({ cookies: { affiliateToken: token } }), expired, () => assert.fail('expired token accepted'));
  assert.equal(expired.statusCode, 401);
});

test('Affiliate reset emails use the established Resend service and generic responses', async () => {
  const models = createModels();
  const emailCodes = [];
  const router = createAffiliateAuthRouter({
    ...models, argon2Module: argon2,
    email: { async sendPasswordResetEmail(_to, code) { emailCodes.push(code); } },
    registrationRateLimit: passThrough, loginRateLimit: passThrough, recoveryRateLimit: passThrough,
    now: () => new Date(NOW), randomInt: () => 654321,
    logger: { error() {} },
  });
  await register(router, { name: 'Affiliate', email: 'a@example.com', password: PASSWORD });
  const existing = await callRoute(router, '/forgot-password', 'post', makeRequest({ body: { email: 'a@example.com' } }));
  const missing = await callRoute(router, '/forgot-password', 'post', makeRequest({ body: { email: 'missing@example.com' } }));
  assert.deepEqual(existing.body, missing.body);
  assert.equal(emailCodes[0], '654321');
  const account = models.affiliates[0];
  assert.equal(account.resetCode, crypto.createHash('sha256').update('654321').digest('hex'));
  assert.equal(account.resetCodeExpiry.getTime(), NOW.getTime() + 15 * 60 * 1000);
  const reset = await callRoute(router, '/reset-password', 'post', makeRequest({ body: {
    email: 'a@example.com', code: '654321', newPassword: 'new-correct-horse-battery-42',
  } }));
  assert.equal(reset.statusCode, 200);
  assert.equal(await argon2.verify(account.passwordHash, 'new-correct-horse-battery-42'), true);
  assert.equal(account.resetCode, undefined);
  assert.ok(models.sessions[0].revokedAt instanceof Date);
});

test('Affiliate schema has independent unique and TTL indexes and omits secrets', async () => {
  const affiliate = new Affiliate({ name: 'Demo', email: ' DEMO@EXAMPLE.COM ', passwordHash: '$argon2id$test' });
  assert.equal(affiliate.email, 'demo@example.com');
  assert.equal(Object.hasOwn(affiliate.toJSON(), 'passwordHash'), false);
  assert.equal(Object.hasOwn(affiliate.toJSON(), 'resetCode'), false);
  await assert.rejects(new AffiliateSession({ affiliate: new (require('mongoose').Types.ObjectId)(), tokenHash: 'a'.repeat(64), createdAt: NOW, expiresAt: new Date(NOW.getTime() + SESSION_AGE_MS + 1) }).validate(), /cannot last longer than seven days/);
  assert.equal(Affiliate.schema.indexes().some(([fields, opts]) => fields.email === 1 && opts.unique), true);
  assert.equal(AffiliateSession.schema.indexes().some(([fields, opts]) => fields.expiresAt === 1 && opts.expireAfterSeconds === 0), true);
  assert.deepEqual(cookieOptions('production'), { httpOnly: true, secure: true, sameSite: 'none', path: '/', maxAge: SESSION_AGE_MS });
});
