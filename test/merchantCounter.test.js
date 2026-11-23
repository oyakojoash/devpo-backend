const { test } = require('node:test');
const assert = require('node:assert/strict');
const MerchantCounter = require('../models/MerchantCounter');

test('merchant counter allocates with one atomic increment on the initialized singleton', async () => {
  const original = MerchantCounter.findOneAndUpdate;
  const calls = [];
  let value = 0;
  MerchantCounter.findOneAndUpdate = (...args) => {
    calls.push(args);
    value += 1;
    return { lean: async () => ({ value }) };
  };
  try {
    const ids = await Promise.all(Array.from({ length: 3 }, () => MerchantCounter.allocateNextMerchantId()));
    assert.deepEqual(ids.sort(), ['00001', '00002', '00003']);
    assert.equal(calls.length, 3);
    for (const [filter, update] of calls) {
      assert.deepEqual(filter, { _id: 'merchantId', initialized: true });
      assert.deepEqual(update, { $inc: { value: 1 } });
    }
  } finally {
    MerchantCounter.findOneAndUpdate = original;
  }
});

test('merchant counter remains unavailable before migration initializes it', async () => {
  const original = MerchantCounter.findOneAndUpdate;
  MerchantCounter.findOneAndUpdate = () => ({ lean: async () => null });
  try {
    assert.equal(await MerchantCounter.allocateNextMerchantId(), null);
  } finally {
    MerchantCounter.findOneAndUpdate = original;
  }
});

test('merchant counter formats IDs beyond five digits without truncation', async () => {
  const original = MerchantCounter.findOneAndUpdate;
  MerchantCounter.findOneAndUpdate = () => ({ lean: async () => ({ value: 100000 }) });
  try {
    assert.equal(await MerchantCounter.allocateNextMerchantId(), '100000');
  } finally {
    MerchantCounter.findOneAndUpdate = original;
  }
});
