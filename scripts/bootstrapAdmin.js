const crypto = require('node:crypto');
const readline = require('node:readline/promises');
const { StringDecoder } = require('node:string_decoder');
const { stdin, stdout } = require('node:process');
const mongoose = require('mongoose');
const Admin = require('../models/adminmodels');

const BOOTSTRAP_SECRET_ENV = 'ADMIN_BOOTSTRAP_SECRET';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const EXPECTED_DATABASE = 'devpo';
const MIN_SECRET_LENGTH = 43;
const ADMIN_EMAIL = 'joashoyako@gmail.com';

class BootstrapError extends Error {}

function validateMongoUri(uri) {
  if (typeof uri !== 'string' || !uri) {
    throw new BootstrapError('MONGO_URI is required.');
  }

  let parsed;
  try {
    parsed = new URL(uri);
  } catch {
    throw new BootstrapError('MONGO_URI is malformed.');
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  let database;
  try {
    database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  } catch {
    throw new BootstrapError('MONGO_URI is malformed.');
  }

  const hasAllowedReplicaSetOption = parsed.searchParams.size === 1 &&
    parsed.searchParams.get('replicaSet') === 'rs0';

  if (parsed.protocol !== 'mongodb:' || !LOCAL_HOSTS.has(hostname) ||
      !['', '27017'].includes(parsed.port) || database !== EXPECTED_DATABASE ||
      parsed.username || parsed.password || (parsed.search && !hasAllowedReplicaSetOption) || parsed.hash) {
    throw new BootstrapError('MONGO_URI must target the unauthenticated local devpo database on the default MongoDB port.');
  }

  return uri;
}

function validateBootstrapSecret(secret) {
  if (typeof secret !== 'string' || secret.length < MIN_SECRET_LENGTH ||
      !/^[A-Za-z0-9_-]+$/.test(secret)) {
    throw new BootstrapError(`${BOOTSTRAP_SECRET_ENV} must be an explicit 43-character-or-longer base64url secret.`);
  }
  return secret;
}

function secretsMatch(expected, supplied) {
  const expectedDigest = crypto.createHash('sha256').update(expected, 'utf8').digest();
  const suppliedDigest = crypto.createHash('sha256').update(supplied, 'utf8').digest();
  return crypto.timingSafeEqual(expectedDigest, suppliedDigest);
}

function validateAdminInput({ fullName, email, password }) {
  if (typeof fullName !== 'string' || fullName.trim().length < 3 || fullName.trim().length > 200) {
    throw new BootstrapError('Full name must contain between 3 and 200 characters.');
  }
  if (typeof email !== 'string' || email.trim().length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    throw new BootstrapError('A valid email address is required.');
  }
  if (typeof password !== 'string' || password.length < 12) {
    throw new BootstrapError('Password must contain at least 12 characters.');
  }

  return {
    fullName: fullName.trim(),
    email: email.trim().toLowerCase(),
    password,
  };
}

function askLine(prompt) {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  return rl.question(prompt).finally(() => rl.close());
}

function askHidden(prompt) {
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
    return Promise.reject(new BootstrapError('Bootstrap requires an interactive terminal.'));
  }

  stdout.write(prompt);
  return new Promise((resolve, reject) => {
    let value = '';
    const decoder = new StringDecoder('utf8');
    const wasRaw = stdin.isRaw;
    const finish = (error) => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(wasRaw);
      stdin.pause();
      stdout.write('\n');
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (buffer) => {
      for (const character of decoder.write(buffer)) {
        if (character === '\u0003') return finish(new BootstrapError('Bootstrap cancelled.'));
        if (character === '\r' || character === '\n') return finish();
        if (character === '\u007f' || character === '\b') value = value.slice(0, -1);
        else if (character >= ' ') value += character;
      }
    };

    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}

async function promptAdminDetails() {
  const fullName = await askLine('Administrator full name: ');
  const password = await askHidden('Administrator password (input hidden): ');
  return { fullName, email: ADMIN_EMAIL, password };
}

async function bootstrapAdmin({
  env = process.env,
  db = mongoose,
  AdminModel = Admin,
  confirmSecret = askHidden,
  promptDetails = promptAdminDetails,
} = {}) {
  if (env.NODE_ENV !== 'development') {
    throw new BootstrapError('Admin bootstrap is allowed only when NODE_ENV is exactly development.');
  }

  const uri = validateMongoUri(env.MONGO_URI);
  const expectedSecret = validateBootstrapSecret(env[BOOTSTRAP_SECRET_ENV]);
  const suppliedSecret = await confirmSecret('Enter the bootstrap secret to confirm: ');
  if (typeof suppliedSecret !== 'string' || !secretsMatch(expectedSecret, suppliedSecret)) {
    throw new BootstrapError('Bootstrap secret did not match.');
  }

  try {
    await db.connect(uri);
    if (await AdminModel.exists({ email: ADMIN_EMAIL })) {
      throw new BootstrapError(`An Admin account for ${ADMIN_EMAIL} already exists; refusing to create a duplicate.`);
    }

    const details = validateAdminInput(await promptDetails());
    if (details.email !== ADMIN_EMAIL) {
      throw new BootstrapError(`This bootstrap command only creates ${ADMIN_EMAIL}.`);
    }

    // Recheck after prompting to catch an account created while details were entered.
    if (await AdminModel.exists({ email: ADMIN_EMAIL })) {
      throw new BootstrapError(`An Admin account for ${ADMIN_EMAIL} already exists; refusing to create a duplicate.`);
    }

    try {
      // Admin.create invokes the schema save hook, which hashes with bcrypt (10 rounds).
      await AdminModel.create({ ...details, role: 'admin' });
    } catch (error) {
      if (error?.code === 11000) {
        throw new BootstrapError(`An Admin account for ${ADMIN_EMAIL} already exists; refusing to create a duplicate.`);
      }
      throw error;
    }
    return `Admin account created for ${ADMIN_EMAIL}.`;
  } finally {
    await db.disconnect();
  }
}

async function main() {
  require('dotenv').config();
  try {
    const message = await bootstrapAdmin();
    stdout.write(`${message}\n`);
  } catch (error) {
    // Only controlled BootstrapError messages are safe to print; driver/model
    // errors can contain connection details or submitted field values.
    stdout.write(`${error instanceof BootstrapError ? error.message : 'Admin bootstrap failed due to an internal error.'}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  BootstrapError,
  bootstrapAdmin,
  secretsMatch,
  validateAdminInput,
  validateBootstrapSecret,
  validateMongoUri,
};
