const { inspectCollectionIndexes } = require('./readOnlyIndexInspection');

const REQUIRED_INDEX = {
  name: 'uniq_affiliate_product_promotion',
  key: { affiliate: 1, product: 1 },
  unique: true,
};

async function ensureAffiliatePromotionIndex(PromotionModel) {
  const indexes = await inspectCollectionIndexes(PromotionModel);
  const ready = indexes.some((index) => {
    const options = Object.fromEntries(Object.entries(index).filter(([key]) => !['name', 'key', 'v', 'ns', 'background'].includes(key)));
    return index.name === REQUIRED_INDEX.name &&
      JSON.stringify(index.key) === JSON.stringify(REQUIRED_INDEX.key) &&
      JSON.stringify(options) === JSON.stringify({ unique: true });
  });
  if (!ready) {
    const error = new Error('Required unique AffiliatePromotion index is missing or has unexpected options');
    error.code = 'AFFILIATE_PROMOTION_INDEX_NOT_READY';
    throw error;
  }
}

module.exports = { ensureAffiliatePromotionIndex, REQUIRED_INDEX };
