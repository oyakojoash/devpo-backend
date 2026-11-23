const { test } = require('node:test');
const assert = require('node:assert/strict');
const AffiliateReferral = require('../models/AffiliateReferral');
const AffiliateRecruitmentReferral = require('../models/AffiliateRecruitmentReferral');
const { REQUIRED_INDEXES, ensureAffiliateReferralIndexes } = require('../utils/affiliateReferralIndexReadiness');
const { hasEquivalentIndexDefinition } = require('../utils/referralIndexDefinition');
const { COLLECTIONS, SPEC, hasDefinition, provisionCollection } = require('../scripts/migrateAffiliateReferralIndexes');
const { createProductReferral, createRecruitmentReferral, MAX_CODE_ATTEMPTS } = require('../services/affiliateReferralService');

const id = () => new AffiliateReferral.db.base.Types.ObjectId();

test('product referral schema has required immutable references and lifecycle', async () => {
  const referral = new AffiliateReferral({ affiliate: id(), affiliatePromotion: id(), product: id(), referralCode: 'client-chosen' });
  await referral.validate();
  assert.match(referral.referralCode, /^P-[A-Za-z0-9_-]{16}$/);
  assert.equal(referral.status, 'active');
  for (const field of ['affiliate', 'affiliatePromotion', 'product', 'referralCode']) assert.equal(AffiliateReferral.schema.path(field).options.immutable, true);
  await assert.rejects(new AffiliateReferral({ affiliate: id(), affiliatePromotion: id(), product: id(), status: 'withdrawn' }).validate());
});

test('recruitment identity has a separate generated namespace and one-referrer index', async () => {
  const referral = new AffiliateRecruitmentReferral({ referrer: id(), referralCode: 'client-chosen' });
  await referral.validate();
  assert.match(referral.referralCode, /^R-[A-Za-z0-9_-]{16}$/);
  assert.equal(referral.status, 'active');
  assert.equal(AffiliateRecruitmentReferral.schema.path('referrer').options.immutable, true);
  await assert.rejects(new AffiliateRecruitmentReferral({ referrer: id(), referralCode: 'R-manual', status: 'pending' }).validate());
});

test('referral identity schemas disable automatic index and collection creation and declare required unique indexes', () => {
  for (const Model of [AffiliateReferral, AffiliateRecruitmentReferral]) {
    assert.equal(Model.schema.options.autoIndex, false);
    assert.equal(Model.schema.options.autoCreate, false);
    assert.equal(Model.schema.options.timestamps, true);
  }
  for (const group of Object.values(REQUIRED_INDEXES)) {
    assert.equal(group.length, 2);
    assert.ok(group.every((index) => index.unique === true && index.name));
  }
  assert.ok(REQUIRED_INDEXES.AffiliateReferral.some((item) => item.key.affiliatePromotion === 1));
  assert.ok(REQUIRED_INDEXES.AffiliateRecruitmentReferral.some((item) => item.key.referrer === 1));
});

test('manual provisioning covers both new collections and does not allow conflicting index definitions', () => {
  assert.equal(COLLECTIONS.AffiliateReferral, 'affiliatereferrals');
  assert.equal(COLLECTIONS.AffiliateRecruitmentReferral, 'affiliaterecruitmentreferrals');
  assert.deepEqual(SPEC.AffiliateReferral.refs, {
    affiliate: 'affiliates', affiliatePromotion: 'affiliatepromotions', product: 'merchantproducts',
  });
  assert.deepEqual(SPEC.AffiliateRecruitmentReferral.refs, { referrer: 'affiliates' });
  const expected = REQUIRED_INDEXES.AffiliateReferral[0];
  assert.equal(hasDefinition({ name: expected.name, key: expected.key, unique: true }, expected), true);
  assert.equal(hasDefinition({ name: expected.name, key: expected.key, unique: false }, expected), false);
  assert.equal(hasDefinition({ name: 'legacy_custom_name', key: expected.key, unique: true }, expected), true);
});

function indexInspectionModel(modelName, indexes) {
  const collectionName = modelName === 'AffiliateReferral' ? 'affiliatereferrals' : 'affiliaterecruitmentreferrals';
  return {
    modelName,
    collection: { collectionName },
    db: { db: {
      listCollections: () => ({ hasNext: async () => true }),
      collection: () => ({ listIndexes: () => ({ toArray: async () => indexes }) }),
    } },
  };
}

function referralIndexModels({ productIndexes = REQUIRED_INDEXES.AffiliateReferral, recruitmentIndexes = REQUIRED_INDEXES.AffiliateRecruitmentReferral } = {}) {
  return [
    indexInspectionModel('AffiliateReferral', productIndexes),
    indexInspectionModel('AffiliateRecruitmentReferral', recruitmentIndexes),
  ];
}

test('readiness accepts the expected definitions for all four referral indexes', async () => {
  await ensureAffiliateReferralIndexes(...referralIndexModels());
});

test('readiness accepts equivalent alternate-name definitions for all four referral indexes', async () => {
  const rename = (indexes) => indexes.map((index, position) => ({ ...index, name: `alternate_${position}` }));
  await ensureAffiliateReferralIndexes(...referralIndexModels({
    productIndexes: rename(REQUIRED_INDEXES.AffiliateReferral),
    recruitmentIndexes: rename(REQUIRED_INDEXES.AffiliateRecruitmentReferral),
  }));
});

test('readiness rejects wrong uniqueness, key ordering, conflicting options, and missing indexes', async () => {
  for (const [group, expectedIndexes] of Object.entries(REQUIRED_INDEXES)) {
    for (let position = 0; position < expectedIndexes.length; position += 1) {
      for (const change of [
        (index) => ({ ...index, unique: false }),
        (index) => ({ ...index, key: { unrelatedField: 1 } }),
        (index) => ({ ...index, sparse: true }),
        (index) => ({ ...index, partialFilterExpression: { unrelatedField: { $exists: true } } }),
      ]) {
        const changed = expectedIndexes.map((index, indexPosition) => indexPosition === position ? change(index) : index);
        const options = group === 'AffiliateReferral'
          ? { productIndexes: changed }
          : { recruitmentIndexes: changed };
        await assert.rejects(
          ensureAffiliateReferralIndexes(...referralIndexModels(options)),
          (error) => error.code === 'AFFILIATE_REFERRAL_INDEX_NOT_READY',
          `${group} index ${expectedIndexes[position].name} should reject incompatible definition`,
        );
      }
      const missing = expectedIndexes.filter((_index, indexPosition) => indexPosition !== position);
      const options = group === 'AffiliateReferral'
        ? { productIndexes: missing }
        : { recruitmentIndexes: missing };
      await assert.rejects(
        ensureAffiliateReferralIndexes(...referralIndexModels(options)),
        (error) => error.code === 'AFFILIATE_REFERRAL_INDEX_NOT_READY',
        `${group} index ${expectedIndexes[position].name} should be required`,
      );
    }
  }
  assert.equal(hasEquivalentIndexDefinition(
    { key: { second: 1, first: 1 }, unique: true },
    { key: { first: 1, second: 1 }, unique: true },
  ), false, 'compound key ordering is significant');
});

function duplicateKey(keyPattern, indexName) {
  return Object.assign(new Error(`E11000 duplicate key error collection: test.referrals index: ${indexName} dup key: { ${Object.keys(keyPattern).join(', ')} }`), { code: 11000, keyPattern });
}

function duplicateKeyWithoutPattern(indexName) {
  return Object.assign(new Error(`E11000 duplicate key error collection: test.referrals index: ${indexName} dup key: { referralCode: "existing" }`), { code: 11000 });
}

function promotionModel(promotion) {
  return { findById: () => ({ lean: async () => promotion }) };
}

test('product referral creation loads a matching promotion and uses its ownership fields', async () => {
  const affiliate = id();
  const product = id();
  const promotion = { _id: id(), affiliate, product };
  let created;
  const result = await createProductReferral({ affiliateId: affiliate, affiliatePromotionId: promotion._id, productId: product }, {
    AffiliatePromotionModel: promotionModel(promotion),
    AffiliateReferralModel: { async create(data) { created = data; return data; } },
  });
  assert.deepEqual(created, { affiliate, affiliatePromotion: promotion._id, product });
  assert.strictEqual(result, created);
});

test('product referral creation rejects a missing promotion before saving', async () => {
  let creates = 0;
  await assert.rejects(createProductReferral({ affiliateId: id(), affiliatePromotionId: id(), productId: id() }, {
    AffiliatePromotionModel: promotionModel(null), AffiliateReferralModel: { async create() { creates += 1; } },
  }), (error) => error.code === 'AFFILIATE_PROMOTION_NOT_FOUND');
  assert.equal(creates, 0);
});

test('product referral creation rejects affiliate and product ownership mismatches', async () => {
  const affiliate = id();
  const product = id();
  const promotion = { _id: id(), affiliate: id(), product };
  let creates = 0;
  const deps = { AffiliatePromotionModel: promotionModel(promotion), AffiliateReferralModel: { async create() { creates += 1; } } };
  await assert.rejects(createProductReferral({ affiliateId: affiliate, affiliatePromotionId: promotion._id, productId: product }, deps),
    (error) => error.code === 'AFFILIATE_PROMOTION_OWNERSHIP_MISMATCH');
  promotion.affiliate = affiliate;
  await assert.rejects(createProductReferral({ affiliateId: affiliate, affiliatePromotionId: promotion._id, productId: id() }, deps),
    (error) => error.code === 'AFFILIATE_PROMOTION_PRODUCT_MISMATCH');
  assert.equal(creates, 0);
});

test('recruitment referral requires an existing referrer affiliate', async () => {
  const affiliate = { _id: id() };
  let created;
  await createRecruitmentReferral({ referrerId: affiliate._id }, {
    AffiliateModel: { async findById() { return affiliate; } },
    AffiliateRecruitmentReferralModel: { async create(data) { created = data; return data; } },
  });
  assert.deepEqual(created, { referrer: affiliate._id });
  let creates = 0;
  await assert.rejects(createRecruitmentReferral({ referrerId: id() }, {
    AffiliateModel: { async findById() { return null; } },
    AffiliateRecruitmentReferralModel: { async create() { creates += 1; } },
  }), (error) => error.code === 'REFERRER_NOT_FOUND');
  await assert.rejects(createRecruitmentReferral({ referrerId: 'invalid' }, {
    AffiliateModel: { async findById() { throw new Error('should not query'); } },
    AffiliateRecruitmentReferralModel: { async create() { creates += 1; } },
  }), (error) => error.code === 'INVALID_REFERRAL_REFERENCE');
  assert.equal(creates, 0);
});

test('product and recruitment code collisions retry and succeed', async () => {
  let productAttempts = 0;
  const affiliateId = id();
  const promotion = { _id: id(), affiliate: affiliateId, product: id() };
  productAttempts = 0;
  assert.equal(await createProductReferral({ affiliateId, affiliatePromotionId: promotion._id, productId: promotion.product }, {
    AffiliatePromotionModel: promotionModel(promotion),
    AffiliateReferralModel: { async create() { productAttempts += 1; if (productAttempts === 1) throw duplicateKey({ referralCode: 1 }, 'uniq_affiliate_referral_code'); return 'product-created'; } },
  }), 'product-created');
  assert.equal(productAttempts, 2);

  let recruitmentAttempts = 0;
  assert.equal(await createRecruitmentReferral({ referrerId: affiliateId }, {
    AffiliateModel: { async findById() { return { _id: affiliateId }; } },
    AffiliateRecruitmentReferralModel: { async create() { recruitmentAttempts += 1; if (recruitmentAttempts === 1) throw duplicateKey({ referralCode: 1 }, 'uniq_recruitment_referral_code'); return 'recruitment-created'; } },
  }), 'recruitment-created');
  assert.equal(recruitmentAttempts, 2);
});

test('product and recruitment code retries accept exact index names without keyPattern', async () => {
  const affiliateId = id();
  const promotion = { _id: id(), affiliate: affiliateId, product: id() };
  let productAttempts = 0;
  const productResult = await createProductReferral({ affiliateId, affiliatePromotionId: promotion._id, productId: promotion.product }, {
    AffiliatePromotionModel: promotionModel(promotion),
    AffiliateReferralModel: { async create() { productAttempts += 1; if (productAttempts === 1) throw duplicateKeyWithoutPattern('uniq_affiliate_referral_code'); return 'product-created'; } },
  });
  assert.equal(productResult, 'product-created');
  assert.equal(productAttempts, 2);

  let recruitmentAttempts = 0;
  const recruitmentResult = await createRecruitmentReferral({ referrerId: affiliateId }, {
    AffiliateModel: { async findById() { return { _id: affiliateId }; } },
    AffiliateRecruitmentReferralModel: { async create() { recruitmentAttempts += 1; if (recruitmentAttempts === 1) throw duplicateKeyWithoutPattern('uniq_recruitment_referral_code'); return 'recruitment-created'; } },
  });
  assert.equal(recruitmentResult, 'recruitment-created');
  assert.equal(recruitmentAttempts, 2);
});

test('prefixed, malformed, missing-name, and unrelated duplicate errors are never code-retried', async () => {
  const affiliateId = id();
  const promotion = { _id: id(), affiliate: affiliateId, product: id() };
  const invalidMessages = [
    'E11000 duplicate key error collection: test.referrals index: uniq_affiliate_referral_code_extra dup key: { referralCode: "x" }',
    'E11000 duplicate key error collection: test.referrals dup key: { referralCode: "x" }',
    'not a parseable MongoDB duplicate-key message',
    'garbage index: uniq_affiliate_referral_code dup key: {}',
    'garbage index: uniq_recruitment_referral_code dup key: {}',
    'E11000 index: another_index index: uniq_affiliate_referral_code dup key: { referralCode: "x" }',
    'E11000 index: uniq_affiliate_referral_code dup key: {} dup key: {}',
  ];

  for (const [message, keyPattern] of [
    ...invalidMessages.map((item) => [item, undefined]),
    ['E11000 duplicate key error collection: test.referrals index: uniq_affiliate_referral_code dup key: {}', { referralCode: 1, other: 1 }],
    ['E11000 duplicate key error collection: test.referrals index: uniq_affiliate_referral_code dup key: {}', { unrelated: 1 }],
  ]) {
    const error = Object.assign(new Error(message), { code: 11000, ...(keyPattern ? { keyPattern } : {}) });
    let productAttempts = 0;
    await assert.rejects(createProductReferral({ affiliateId, affiliatePromotionId: promotion._id, productId: promotion.product }, {
      AffiliatePromotionModel: promotionModel(promotion),
      AffiliateReferralModel: { async create() { productAttempts += 1; throw error; } },
    }), (actual) => actual === error);
    assert.equal(productAttempts, 1);

    let recruitmentAttempts = 0;
    await assert.rejects(createRecruitmentReferral({ referrerId: affiliateId }, {
      AffiliateModel: { async findById() { return { _id: affiliateId }; } },
      AffiliateRecruitmentReferralModel: { async create() { recruitmentAttempts += 1; throw error; } },
    }), (actual) => actual === error);
    assert.equal(recruitmentAttempts, 1);
  }
});

test('referral code retry exhaustion is bounded and uniqueness conflicts are not retried', async () => {
  const affiliate = id();
  const promotion = { _id: id(), affiliate, product: id() };
  let attempts = 0;
  await assert.rejects(createProductReferral({ affiliateId: affiliate, affiliatePromotionId: promotion._id, productId: promotion.product }, {
    AffiliatePromotionModel: promotionModel(promotion),
    AffiliateReferralModel: { async create() { attempts += 1; throw duplicateKey({ referralCode: 1 }, 'uniq_affiliate_referral_code'); } },
  }), (error) => error.code === 'REFERRAL_CODE_RETRY_EXHAUSTED');
  assert.equal(attempts, MAX_CODE_ATTEMPTS);

  attempts = 0;
  await assert.rejects(createRecruitmentReferral({ referrerId: affiliate }, {
    AffiliateModel: { async findById() { return { _id: affiliate }; } },
    AffiliateRecruitmentReferralModel: { async create() { attempts += 1; throw duplicateKey({ referralCode: 1 }, 'uniq_recruitment_referral_code'); } },
  }), (error) => error.code === 'REFERRAL_CODE_RETRY_EXHAUSTED');
  assert.equal(attempts, MAX_CODE_ATTEMPTS);

  attempts = 0;
  const promotionConflict = duplicateKey({ affiliatePromotion: 1 }, 'uniq_affiliate_referral_promotion');
  await assert.rejects(createProductReferral({ affiliateId: affiliate, affiliatePromotionId: promotion._id, productId: promotion.product }, {
    AffiliatePromotionModel: promotionModel(promotion),
    AffiliateReferralModel: { async create() { attempts += 1; throw promotionConflict; } },
  }), (error) => error === promotionConflict);
  assert.equal(attempts, 1);

  const referrerConflict = duplicateKey({ referrer: 1 }, 'uniq_recruitment_referrer');
  attempts = 0;
  await assert.rejects(createRecruitmentReferral({ referrerId: affiliate }, {
    AffiliateModel: { async findById() { return { _id: affiliate }; } },
    AffiliateRecruitmentReferralModel: { async create() { attempts += 1; throw referrerConflict; } },
  }), (error) => error === referrerConflict);
  assert.equal(attempts, 1);

  const unrelated = Object.assign(new Error('database unavailable'), { code: 'ECONNRESET' });
  await assert.rejects(createRecruitmentReferral({ referrerId: affiliate }, {
    AffiliateModel: { async findById() { return { _id: affiliate }; } },
    AffiliateRecruitmentReferralModel: { async create() { throw unrelated; } },
  }), (error) => error === unrelated);
});

test('identity fields remain immutable through document and query update paths', () => {
  for (const [Model, fields, initial] of [
    [AffiliateReferral, ['affiliate', 'affiliatePromotion', 'product', 'referralCode'], { affiliate: id(), affiliatePromotion: id(), product: id(), referralCode: 'P-abcdefghijklmnop' }],
    [AffiliateRecruitmentReferral, ['referrer', 'referralCode'], { referrer: id(), referralCode: 'R-abcdefghijklmnop' }],
  ]) {
    const document = new Model(initial);
    document.$isNew = false;
    const original = Object.fromEntries(fields.map((field) => [field, String(document.get(field))]));
    for (const field of fields) document.set(field, field === 'referralCode' ? 'P-zyxwvutsrqponmlk' : id());
    assert.deepEqual(Object.fromEntries(fields.map((field) => [field, String(document.get(field))])), original);

    const changes = Object.fromEntries(fields.map((field) => [field, field === 'referralCode' ? 'P-zyxwvutsrqponmlk' : id()]));
    for (const query of [Model.updateOne({ _id: id() }, { $set: changes }), Model.findOneAndUpdate({ _id: id() }, { $set: changes })]) {
      const castUpdate = query._castUpdate();
      for (const field of fields) assert.equal(castUpdate?.$set?.[field], undefined, `${Model.modelName}.${field} query update`);
    }
  }
});

function migrationDatabase(indexes) {
  const created = [];
  const collection = {
    listIndexes: () => ({ toArray: async () => indexes }),
    countDocuments: async () => 0,
    distinct: async () => [],
    aggregate: () => ({ toArray: async () => [] }),
    async createIndex(key, options) { created.push({ key, options }); return options.name; },
  };
  return {
    created,
    db: {
      listCollections: () => ({ hasNext: async () => true }),
      collection: () => collection,
    },
  };
}

test('migration accepts an equivalent index under another name without recreating it', async () => {
  const required = REQUIRED_INDEXES.AffiliateReferral[0];
  const { db, created } = migrationDatabase([{ name: 'legacy_promotion_identity', key: required.key, unique: true }]);
  await provisionCollection(db, 'AffiliateReferral');
  assert.equal(created.length, 1);
  assert.deepEqual(created[0].key, { referralCode: 1 });
});

test('migration rejects a conflicting index definition even when its name differs', async () => {
  const required = REQUIRED_INDEXES.AffiliateReferral[0];
  const { db, created } = migrationDatabase([{ name: 'legacy_promotion_identity', key: required.key, unique: false }]);
  await assert.rejects(provisionCollection(db, 'AffiliateReferral'), /conflicting definition/);
  assert.equal(created.length, 0);
});
