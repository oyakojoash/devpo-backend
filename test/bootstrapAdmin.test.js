const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');
const Admin = require('../models/adminmodels');
const {
  bootstrapAdmin,
  validateMongoUri,
} = require('../scripts/bootstrapAdmin');

const secret = '0123456789abcdefghijklmnopqrstuvABCDEFG_-0123456789';
const localUri = 'mongodb://localhost:27017/devpo';
const validEnv = {
  NODE_ENV: 'development',
  MONGO_URI: localUri,
  ADMIN_BOOTSTRAP_SECRET: secret,
};
const validDetails = {
  fullName: 'Local Administrator',
  email: 'ADMIN@example.test',
  password: 'a-long-test-password',
};

function makeDependencies(overrides = {}) {
  const calls = { connect: [], disconnect: 0, count: 0, create: [], prompt: 0 };
  const db = {
    async connect(uri) { calls.connect.push(uri); },
    async disconnect() { calls.disconnect += 1; },
  };
  const AdminModel = {
    async countDocuments() { calls.count += 1; return 0; },
    async create(document) { calls.create.push(document); },
  };
  return {
    calls,
    options: {
      env: { ...validEnv },
      db,
      AdminModel,
      confirmSecret: async () => secret,
      promptDetails: async () => { calls.prompt += 1; return { ...validDetails }; },
      ...overrides,
    },
  };
}

test('rejects production before connecting', async () => {
  const { calls, options } = makeDependencies();
  options.env.NODE_ENV = 'production';
  await assert.rejects(bootstrapAdmin(options), /NODE_ENV is exactly development/);
  assert.equal(calls.connect.length, 0);
  assert.equal(calls.disconnect, 0);
});

test('rejects a missing setup secret before connecting', async () => {
  const { calls, options } = makeDependencies();
  delete options.env.ADMIN_BOOTSTRAP_SECRET;
  await assert.rejects(bootstrapAdmin(options), /ADMIN_BOOTSTRAP_SECRET/);
  assert.equal(calls.connect.length, 0);
});

test('rejects an incorrect setup secret before connecting', async () => {
  const { calls, options } = makeDependencies({ confirmSecret: async () => `${secret}wrong` });
  await assert.rejects(bootstrapAdmin(options), /secret did not match/);
  assert.equal(calls.connect.length, 0);
});

test('rejects remote MongoDB hosts before connecting', async () => {
  const { calls, options } = makeDependencies();
  options.env.MONGO_URI = 'mongodb://db.example.test:27017/devpo';
  await assert.rejects(bootstrapAdmin(options), /MONGO_URI must target/);
  assert.equal(calls.connect.length, 0);
});

test('rejects a non-devpo database before connecting', async () => {
  const { calls, options } = makeDependencies();
  options.env.MONGO_URI = 'mongodb://localhost:27017/production';
  await assert.rejects(bootstrapAdmin(options), /MONGO_URI must target/);
  assert.equal(calls.connect.length, 0);
});

test('rejects malformed MongoDB URIs before connecting', async () => {
  const { calls, options } = makeDependencies();
  options.env.MONGO_URI = 'not-a-mongodb-uri';
  await assert.rejects(bootstrapAdmin(options), /MONGO_URI is malformed/);
  assert.equal(calls.connect.length, 0);
});

test('URI validation rejects credentials, unexpected ports and URI options', () => {
  for (const uri of [
    'mongodb://user:pass@localhost:27017/devpo',
    'mongodb://localhost:27018/devpo',
    'mongodb://localhost:27017/devpo?replicaSet=remote',
  ]) {
    assert.throws(() => validateMongoUri(uri), /MONGO_URI must target/);
  }
});

test('refuses to create when an Admin already exists and still disconnects', async () => {
  const { calls, options } = makeDependencies();
  options.AdminModel.countDocuments = async () => { calls.count += 1; return 1; };
  await assert.rejects(bootstrapAdmin(options), /An Admin already exists/);
  assert.equal(calls.create.length, 0);
  assert.equal(calls.prompt, 0);
  assert.equal(calls.disconnect, 1);
});

test('creates using Admin.create and the existing save hook hashes the password', async () => {
  const { calls, options } = makeDependencies();
  let createdInstance;
  options.AdminModel.create = async (document) => {
    calls.create.push(document);
    const instance = new Admin(document);
    await new Promise((resolve, reject) => {
      Admin.schema.s.hooks.execPre('save', instance, [], (error) => error ? reject(error) : resolve());
    });
    createdInstance = instance;
    return instance;
  };

  assert.equal(await bootstrapAdmin(options), 'First Admin created.');
  assert.equal(calls.connect[0], localUri);
  assert.equal(calls.disconnect, 1);
  assert.equal(calls.count, 2);
  assert.equal(calls.create.length, 1);
  assert.equal(calls.create[0].fullName, validDetails.fullName);
  assert.equal(calls.create[0].email, 'admin@example.test');
  assert.equal(calls.create[0].password, validDetails.password);
  assert.notEqual(createdInstance.password, validDetails.password);
  const stored = await bcrypt.compare(validDetails.password, createdInstance.password);
  assert.equal(stored, true);
});

test('disconnects when creation fails', async () => {
  const { calls, options } = makeDependencies();
  options.AdminModel.create = async () => { throw new Error('database failure'); };
  await assert.rejects(bootstrapAdmin(options), /database failure/);
  assert.equal(calls.disconnect, 1);
});

test('disconnects when database connection fails', async () => {
  const { calls, options } = makeDependencies();
  options.db.connect = async () => { throw new Error('connection failure'); };
  await assert.rejects(bootstrapAdmin(options), /connection failure/);
  assert.equal(calls.disconnect, 1);
});

test('validates administrator fields before creation', async () => {
  const { calls, options } = makeDependencies({
    promptDetails: async () => ({ ...validDetails, password: 'short' }),
  });
  await assert.rejects(bootstrapAdmin(options), /at least 12 characters/);
  assert.equal(calls.create.length, 0);
  assert.equal(calls.disconnect, 1);
});
