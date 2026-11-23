const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { createAffiliateReferralsRouter } = require('../routes/affiliateReferrals');

const AFFILIATE_A = new mongoose.Types.ObjectId('507f1f77bcf86cd799439011');
const AFFILIATE_B = new mongoose.Types.ObjectId('507f1f77bcf86cd799439012');
const PROMOTION_ID = new mongoose.Types.ObjectId('507f1f77bcf86cd799439013');
const PRODUCT_ID = new mongoose.Types.ObjectId('507f1f77bcf86cd799439014');

function response() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
  };
}

async function callRoute(router, routePath, req) {
  const route = router.stack.find((layer) => layer.route?.path === routePath && layer.route.methods.post)?.route;
  assert.ok(route, `Expected POST ${routePath}`);
  const res = response();
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

function makeHarness({ affiliateId = AFFILIATE_A, promotion = { _id: PROMOTION_ID, affiliate: AFFILIATE_A, product: PRODUCT_ID }, serviceOverrides = {} } = {}) {
  const state = { promotionsRead: 0, productCreateCalls: [], recruitmentCreateCalls: [], productReferrals: [], recruitmentReferrals: [], fallbackLookups: 0 };
  const AffiliatePromotionModel = {
    findById(id) {
      state.promotionsRead += 1;
      assert.equal(String(id), String(PROMOTION_ID));
      return { lean: async () => promotion };
    },
  };
  const AffiliateModel = { async findById(id) { return { _id: id }; } };
  const AffiliateReferralModel = {
    async create(data) {
      state.productCreateCalls.push(data);
      if (state.productReferrals.some((item) => String(item.affiliatePromotion) === String(data.affiliatePromotion))) {
        throw Object.assign(new Error('private database duplicate details'), { code: 11000, keyPattern: { affiliatePromotion: 1 } });
      }
      const referral = {
        _id: new mongoose.Types.ObjectId(), referralCode: 'P-abcdefghijklmnop',
        status: 'active', ...data,
      };
      state.productReferrals.push(referral);
      return referral;
    },
    findOne(filter) {
      state.fallbackLookups += 1;
      return { lean: async () => state.productReferrals.find((item) => String(item.affiliatePromotion) === String(filter.affiliatePromotion)) || null };
    },
  };
  const AffiliateRecruitmentReferralModel = {
    async create(data) {
      state.recruitmentCreateCalls.push(data);
      if (state.recruitmentReferrals.some((item) => String(item.referrer) === String(data.referrer))) {
        throw Object.assign(new Error('private database duplicate details'), { code: 11000, keyPattern: { referrer: 1 } });
      }
      const referral = { _id: new mongoose.Types.ObjectId(), referralCode: 'R-abcdefghijklmnop', status: 'active', ...data };
      state.recruitmentReferrals.push(referral);
      return referral;
    },
    findOne(filter) {
      state.fallbackLookups += 1;
      return { lean: async () => state.recruitmentReferrals.find((item) => String(item.referrer) === String(filter.referrer)) || null };
    },
  };
  const router = createAffiliateReferralsRouter({
    AffiliateModel,
    AffiliatePromotionModel,
    AffiliateReferralModel,
    AffiliateRecruitmentReferralModel,
    protect(req, _res, next) { req.affiliate = { _id: affiliateId }; next(); },
    ...serviceOverrides,
  });
  const request = (body = {}) => ({ body, cookies: {}, query: {}, params: {}, affiliate: undefined });
  return { router, request, state };
}

test('unauthenticated product and recruitment creation requests are rejected', async () => {
  const router = createAffiliateReferralsRouter();
  const req = { body: { promotionId: String(PROMOTION_ID) }, cookies: {}, query: {}, params: {} };
  assert.equal((await callRoute(router, '/', req)).statusCode, 401);
  assert.equal((await callRoute(router, '/recruitment', { ...req, body: {} })).statusCode, 401);
});

test('product referral creation uses authenticated affiliate and promotion-owned product', async () => {
  const harness = makeHarness();
  const result = await callRoute(harness.router, '/', harness.request({ promotionId: String(PROMOTION_ID) }));
  assert.equal(result.statusCode, 201);
  assert.deepEqual(harness.state.productCreateCalls[0], {
    affiliate: AFFILIATE_A,
    affiliatePromotion: PROMOTION_ID,
    product: PRODUCT_ID,
  });
  assert.deepEqual(result.body.referral, {
    id: String(harness.state.productReferrals[0]._id),
    referralCode: 'P-abcdefghijklmnop',
    promotionId: String(PROMOTION_ID),
    productId: String(PRODUCT_ID),
    status: 'active',
  });
  assert.equal(Object.hasOwn(result.body.referral, 'affiliate'), false);
});

test('client-supplied affiliate or product ownership fields are rejected', async () => {
  const harness = makeHarness();
  const result = await callRoute(harness.router, '/', harness.request({
    promotionId: String(PROMOTION_ID), affiliateId: String(AFFILIATE_B), productId: String(AFFILIATE_B),
  }));
  assert.equal(result.statusCode, 400);
  assert.equal(harness.state.promotionsRead, 0);
  assert.equal(harness.state.productCreateCalls.length, 0);
});

test('product referrals reject another affiliate promotion, invalid IDs, and missing promotions safely', async () => {
  const foreign = makeHarness({ promotion: { _id: PROMOTION_ID, affiliate: AFFILIATE_B, product: PRODUCT_ID } });
  const forbidden = await callRoute(foreign.router, '/', foreign.request({ promotionId: String(PROMOTION_ID) }));
  assert.equal(forbidden.statusCode, 404);
  assert.deepEqual(forbidden.body, { message: 'Affiliate promotion not found' });
  assert.equal(foreign.state.productCreateCalls.length, 0);

  const invalid = makeHarness();
  const invalidResult = await callRoute(invalid.router, '/', invalid.request({ promotionId: 'bad-id' }));
  assert.equal(invalidResult.statusCode, 400);
  assert.equal(invalid.state.promotionsRead, 0);

  const missing = makeHarness({ promotion: null });
  const missingResult = await callRoute(missing.router, '/', missing.request({ promotionId: String(PROMOTION_ID) }));
  assert.equal(missingResult.statusCode, 404);
  assert.equal(missing.state.productCreateCalls.length, 0);
});

test('repeated product referral requests return one existing referral consistently', async () => {
  const harness = makeHarness();
  const results = await Promise.all([
    callRoute(harness.router, '/', harness.request({ promotionId: String(PROMOTION_ID) })),
    callRoute(harness.router, '/', harness.request({ promotionId: String(PROMOTION_ID) })),
  ]);
  assert.deepEqual(results.map((item) => item.statusCode).sort(), [200, 201]);
  assert.deepEqual(results[0].body, results[1].body);
  assert.equal(harness.state.productReferrals.length, 1);
  assert.equal(harness.state.productCreateCalls.length, 2);
});

test('unrelated product duplicate-key errors are not treated as idempotent success', async () => {
  const harness = makeHarness({ serviceOverrides: {
    createProductReferralService: async () => {
      throw Object.assign(new Error('private database duplicate details'), {
        code: 11000,
        keyPattern: { referralCode: 1 },
      });
    },
  } });
  harness.state.productReferrals.push({
    _id: new mongoose.Types.ObjectId(), affiliate: AFFILIATE_A,
    affiliatePromotion: PROMOTION_ID, product: PRODUCT_ID,
    referralCode: 'P-abcdefghijklmnop', status: 'active',
  });

  await assert.rejects(
    () => callRoute(harness.router, '/', harness.request({ promotionId: String(PROMOTION_ID) })),
    /private database duplicate details/,
  );
});

test('product idempotency accepts only the exact index name when keyPattern is absent', async () => {
  const expectedName = 'uniq_affiliate_referral_promotion';
  const exact = makeHarness({ serviceOverrides: {
    createProductReferralService: async () => {
      throw Object.assign(new Error(`E11000 duplicate key error collection: test.referrals index: ${expectedName} dup key: { affiliatePromotion: 1 }`), { code: 11000 });
    },
  } });
  exact.state.productReferrals.push({ _id: new mongoose.Types.ObjectId(), affiliate: AFFILIATE_A, affiliatePromotion: PROMOTION_ID, product: PRODUCT_ID, referralCode: 'P-abcdefghijklmnop', status: 'active' });
  const result = await callRoute(exact.router, '/', exact.request({ promotionId: String(PROMOTION_ID) }));
  assert.equal(result.statusCode, 200);
  assert.equal(exact.state.fallbackLookups, 1);

  const rejectedErrors = [
    Object.assign(new Error(`E11000 duplicate key error collection: test.referrals index: ${expectedName}_extra dup key: { affiliatePromotion: 1 }`), { code: 11000 }),
    Object.assign(new Error(`garbage index: ${expectedName} dup key: {}`), { code: 11000 }),
    Object.assign(new Error('E11000 duplicate key error collection: test.referrals dup key: {}'), { code: 11000 }),
    Object.assign(new Error('malformed duplicate error'), { code: 11000 }),
    Object.assign(new Error('E11000 duplicate key error index: uniq_affiliate_referral_promotion dup key: {}'), { code: 11000, keyPattern: { affiliatePromotion: 1, other: 1 } }),
    Object.assign(new Error('E11000 duplicate key error index: uniq_affiliate_referral_promotion dup key: {}'), { code: 11000, keyPattern: { referralCode: 1 } }),
  ];
  for (const error of rejectedErrors) {
    const harness = makeHarness({ serviceOverrides: { createProductReferralService: async () => { throw error; } } });
    harness.state.productReferrals.push({ _id: new mongoose.Types.ObjectId(), affiliate: AFFILIATE_A, affiliatePromotion: PROMOTION_ID, product: PRODUCT_ID, referralCode: 'P-abcdefghijklmnop', status: 'active' });
    await assert.rejects(() => callRoute(harness.router, '/', harness.request({ promotionId: String(PROMOTION_ID) })), (actual) => actual === error);
    assert.equal(harness.state.fallbackLookups, 0);
  }
});

test('service ownership errors become safe client responses', async () => {
  const harness = makeHarness({ serviceOverrides: {
    createProductReferralService: async () => {
      throw Object.assign(new Error('private database details'), { code: 'AFFILIATE_PROMOTION_OWNERSHIP_MISMATCH' });
    },
  } });
  const result = await callRoute(harness.router, '/', harness.request({ promotionId: String(PROMOTION_ID) }));
  assert.equal(result.statusCode, 404);
  assert.deepEqual(result.body, { message: 'Affiliate promotion not found' });
  assert.equal(JSON.stringify(result.body).includes('private'), false);
});

test('recruitment creation uses the authenticated affiliate and rejects client identity fields', async () => {
  const harness = makeHarness();
  const injected = await callRoute(harness.router, '/recruitment', harness.request({ referrerId: String(AFFILIATE_B) }));
  assert.equal(injected.statusCode, 400);
  assert.equal(harness.state.recruitmentCreateCalls.length, 0);

  const created = await callRoute(harness.router, '/recruitment', harness.request());
  assert.equal(created.statusCode, 201);
  assert.deepEqual(harness.state.recruitmentCreateCalls[0], { referrer: AFFILIATE_A });
  assert.deepEqual(created.body.referral, {
    id: String(harness.state.recruitmentReferrals[0]._id),
    referralCode: 'R-abcdefghijklmnop',
    status: 'active',
  });
  assert.equal(Object.hasOwn(created.body.referral, 'referrer'), false);
});

test('repeated recruitment requests return one existing referral consistently', async () => {
  const harness = makeHarness();
  const results = await Promise.all([
    callRoute(harness.router, '/recruitment', harness.request()),
    callRoute(harness.router, '/recruitment', harness.request()),
  ]);
  assert.deepEqual(results.map((item) => item.statusCode).sort(), [200, 201]);
  assert.deepEqual(results[0].body, results[1].body);
  assert.equal(harness.state.recruitmentReferrals.length, 1);
  assert.equal(harness.state.recruitmentCreateCalls.length, 2);
});

test('unrelated recruitment duplicate-key errors are not treated as idempotent success', async () => {
  const harness = makeHarness({ serviceOverrides: {
    createRecruitmentReferralService: async () => {
      throw Object.assign(new Error('private database duplicate details'), {
        code: 11000,
        keyPattern: { referralCode: 1 },
      });
    },
  } });
  harness.state.recruitmentReferrals.push({
    _id: new mongoose.Types.ObjectId(), referrer: AFFILIATE_A,
    referralCode: 'R-abcdefghijklmnop', status: 'active',
  });

  await assert.rejects(
    () => callRoute(harness.router, '/recruitment', harness.request()),
    /private database duplicate details/,
  );
});

test('recruitment idempotency accepts only the exact index name when keyPattern is absent', async () => {
  const expectedName = 'uniq_recruitment_referrer';
  const exact = makeHarness({ serviceOverrides: {
    createRecruitmentReferralService: async () => {
      throw Object.assign(new Error(`E11000 duplicate key error collection: test.referrals index: ${expectedName} dup key: { referrer: 1 }`), { code: 11000 });
    },
  } });
  exact.state.recruitmentReferrals.push({ _id: new mongoose.Types.ObjectId(), referrer: AFFILIATE_A, referralCode: 'R-abcdefghijklmnop', status: 'active' });
  const result = await callRoute(exact.router, '/recruitment', exact.request());
  assert.equal(result.statusCode, 200);
  assert.equal(exact.state.fallbackLookups, 1);

  const rejectedErrors = [
    Object.assign(new Error(`E11000 duplicate key error collection: test.referrals index: ${expectedName}_extra dup key: { referrer: 1 }`), { code: 11000 }),
    Object.assign(new Error(`garbage index: ${expectedName} dup key: {}`), { code: 11000 }),
    Object.assign(new Error('E11000 duplicate key error collection: test.referrals dup key: {}'), { code: 11000 }),
    Object.assign(new Error('malformed duplicate error'), { code: 11000 }),
    Object.assign(new Error('E11000 duplicate key error index: uniq_recruitment_referrer dup key: {}'), { code: 11000, keyPattern: { referrer: 1, other: 1 } }),
    Object.assign(new Error('E11000 duplicate key error index: uniq_recruitment_referrer dup key: {}'), { code: 11000, keyPattern: { referralCode: 1 } }),
  ];
  for (const error of rejectedErrors) {
    const harness = makeHarness({ serviceOverrides: { createRecruitmentReferralService: async () => { throw error; } } });
    harness.state.recruitmentReferrals.push({ _id: new mongoose.Types.ObjectId(), referrer: AFFILIATE_A, referralCode: 'R-abcdefghijklmnop', status: 'active' });
    await assert.rejects(() => callRoute(harness.router, '/recruitment', harness.request()), (actual) => actual === error);
    assert.equal(harness.state.fallbackLookups, 0);
  }
});

test('recruitment service errors are translated without exposing database details', async () => {
  const harness = makeHarness({ serviceOverrides: {
    createRecruitmentReferralService: async () => {
      throw Object.assign(new Error('private database details'), { code: 'REFERRER_NOT_FOUND' });
    },
  } });
  const result = await callRoute(harness.router, '/recruitment', harness.request());
  assert.equal(result.statusCode, 404);
  assert.deepEqual(result.body, { message: 'Affiliate not found' });
  assert.equal(JSON.stringify(result.body).includes('private'), false);
});
