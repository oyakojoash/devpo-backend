const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const emailService = require('../services/emailService');
const { createEmailService } = emailService;
const User = require('../models/User');
const authRouter = require('../routes/auth');

function makeResponse() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

async function callForgotPassword(user) {
  const route = authRouter.stack.find((layer) => layer.route?.path === '/forgot-password').route;
  const handler = route.stack.at(-1).handle;
  const req = { body: { email: 'person@example.com' } };
  const res = makeResponse();
  await handler(req, res);
  return res;
}

test('customer reset email uses Resend and handles delivery outcomes safely', async (t) => {
  const previousEnv = {
    RESEND_API_KEY: process.env.RESEND_API_KEY,
    EMAIL_FROM: process.env.EMAIL_FROM,
  };
  const originalFindOne = User.findOne;
  const originalSendReset = emailService.sendPasswordResetEmail;
  const emailCalls = [];
  let savedUser;

  process.env.RESEND_API_KEY = 'test-resend-key';
  process.env.EMAIL_FROM = 'Dvepo <noreply@example.com>';

  try {
    await t.test('Resend service sends the code and safe copy through an injected SDK mock', async () => {
      class MockResend {
        constructor(apiKey) { assert.equal(apiKey, 'test-resend-key'); }
        emails = {
          send: async (message) => {
            emailCalls.push(message);
            return { data: { id: 'mock-message-id' }, error: null };
          },
        };
      }

      const service = createEmailService({ Resend: MockResend });
      await service.sendPasswordResetEmail('person@example.com', '123456');
      assert.equal(emailCalls[0].from, 'Dvepo <noreply@example.com>');
      assert.equal(emailCalls[0].to, 'person@example.com');
      assert.match(emailCalls[0].text, /123456/);
      assert.match(emailCalls[0].text, /15 minutes/);
      assert.match(emailCalls[0].text, /Never share/);
    });

    await t.test('unknown email receives the generic response without contacting Resend', async () => {
      User.findOne = async () => null;
      emailService.sendPasswordResetEmail = async () => assert.fail('must not send for an unknown account');
      const response = await callForgotPassword(null);
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.body, { message: 'If the account exists, a reset code has been sent.' });
    });

    await t.test('delivery failure clears the stored code and does not report success', async () => {
      savedUser = {
        resetCode: undefined,
        resetCodeExpiry: undefined,
        saves: 0,
        async save() { this.saves += 1; },
      };
      User.findOne = async () => savedUser;
      emailService.sendPasswordResetEmail = async (_to, code) => {
        assert.match(code, /^\d{6}$/);
        throw Object.assign(new Error('provider response may contain sensitive details'), { name: 'EmailDeliveryError' });
      };

      const response = await callForgotPassword(savedUser);
      assert.equal(response.statusCode, 503);
      assert.equal(response.body.message, 'Unable to send password recovery email');
      assert.equal(savedUser.resetCode, undefined);
      assert.equal(savedUser.resetCodeExpiry, undefined);
      assert.equal(savedUser.saves, 2);
    });

    await t.test('successful delivery preserves a hashed code and 15-minute expiry', async () => {
      const user = {
        resetCode: undefined,
        resetCodeExpiry: undefined,
        saves: 0,
        async save() { this.saves += 1; },
      };
      User.findOne = async () => user;
      emailService.sendPasswordResetEmail = async (_to, code) => {
        assert.match(code, /^\d{6}$/);
        assert.notEqual(user.resetCode, code);
        assert.equal(user.resetCode, crypto.createHash('sha256').update(code).digest('hex'));
      };
      const before = Date.now();
      const response = await callForgotPassword(user);
      const after = Date.now();
      assert.equal(response.statusCode, 200);
      assert.equal(user.saves, 1);
      assert.ok(user.resetCodeExpiry.getTime() >= before + 15 * 60 * 1000);
      assert.ok(user.resetCodeExpiry.getTime() <= after + 15 * 60 * 1000);
    });
  } finally {
    User.findOne = originalFindOne;
    emailService.sendPasswordResetEmail = originalSendReset;
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
