const path = require('node:path');
const { StringDecoder } = require('node:string_decoder');
const { stdin, stdout } = require('node:process');
const dotenv = require('dotenv');
const mongoose = require('mongoose');

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const Admin = require('../models/adminmodels');
const {
  secretsMatch,
  validateBootstrapSecret,
  validateMongoUri,
} = require('./bootstrapAdmin');

const ADMIN_EMAIL = 'joashoyako@gmail.com';
const BOOTSTRAP_SECRET_ENV = 'ADMIN_BOOTSTRAP_SECRET';

function askLine(prompt) {
  const readline = require('node:readline/promises');
  const rl = readline.createInterface({ input: stdin, output: stdout });
  return rl.question(prompt).finally(() => rl.close());
}

function askHidden(prompt) {
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
    return Promise.reject(new Error('Seeder requires an interactive terminal.'));
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
        if (character === '\u0003') return finish(new Error('Seeder cancelled.'));
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

async function main() {
  try {
    if (process.env.NODE_ENV !== 'development') {
      throw new Error('Admin seeding is allowed only when NODE_ENV is exactly development.');
    }

    const uri = validateMongoUri(process.env.MONGO_URI);
    const expectedSecret = validateBootstrapSecret(process.env[BOOTSTRAP_SECRET_ENV]);
    const suppliedSecret = await askHidden('Enter the bootstrap secret to confirm: ');
    if (!secretsMatch(expectedSecret, suppliedSecret)) throw new Error('Bootstrap secret did not match.');

    await mongoose.connect(uri);

    if (await Admin.exists({ email: ADMIN_EMAIL })) {
      stdout.write(`Admin account ${ADMIN_EMAIL} already exists.\n`);
      return;
    }

    const fullName = (await askLine('Administrator full name: ')).trim();
    if (fullName.length < 3 || fullName.length > 200) {
      throw new Error('Full name must contain between 3 and 200 characters.');
    }

    const password = await askHidden('Administrator password (input hidden): ');
    if (password.length < 12) throw new Error('Password must contain at least 12 characters.');

    try {
      // The Admin save hook hashes the plaintext password with the schema's bcrypt settings.
      await Admin.create({ fullName, email: ADMIN_EMAIL, password, role: 'admin' });
      stdout.write(`Admin account ${ADMIN_EMAIL} created successfully.\n`);
    } catch (error) {
      if (error?.code === 11000) {
        stdout.write(`Admin account ${ADMIN_EMAIL} already exists.\n`);
        return;
      }
      throw error;
    }
  } catch (error) {
    stdout.write(`${error.message || 'Admin seeding failed.'}\n`);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) main();
