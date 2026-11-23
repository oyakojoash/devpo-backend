const { inspectCollectionIndexes } = require('./readOnlyIndexInspection');
const EXPECTED_INDEX_FIELDS = [['user', 1], ['idempotencyKey', 1]];

function isRequiredOrderIdempotencyIndex(index) {
  if (!index || index.unique !== true) return false;

  const fields = Object.entries(index.key || {});
  const partial = index.partialFilterExpression;
  if (fields.length !== EXPECTED_INDEX_FIELDS.length) return false;
  if (!fields.every(([field, direction], position) => {
    const [expectedField, expectedDirection] = EXPECTED_INDEX_FIELDS[position];
    return field === expectedField && direction === expectedDirection;
  })) return false;

  return Boolean(
    partial &&
    Object.keys(partial).length === 1 &&
    partial.idempotencyKey &&
    Object.keys(partial.idempotencyKey).length === 1 &&
    partial.idempotencyKey.$type === 'string'
  );
}

async function ensureOrderIdempotencyIndex(OrderModel) {
  const indexes = await inspectCollectionIndexes(OrderModel);
  if (!indexes.some(isRequiredOrderIdempotencyIndex)) {
    const error = new Error('Required unique partial Order idempotency index is missing or has unexpected options');
    error.code = 'ORDER_IDEMPOTENCY_INDEX_MISSING';
    throw error;
  }
}

module.exports = { ensureOrderIdempotencyIndex, isRequiredOrderIdempotencyIndex };