const { isDeepStrictEqual } = require('node:util');

const IGNORED_INDEX_METADATA = new Set(['name', 'key', 'v', 'ns', 'background']);

function indexOptions(index) {
  return Object.fromEntries(Object.entries(index || {}).filter(([key]) => !IGNORED_INDEX_METADATA.has(key)));
}

function hasSameIndexKey(actual, expected) {
  return Boolean(actual?.key && expected?.key) &&
    isDeepStrictEqual(Object.entries(actual.key), Object.entries(expected.key));
}

function hasEquivalentIndexDefinition(actual, expected) {
  // Key order is significant in MongoDB index definitions.
  if (!hasSameIndexKey(actual, expected)) return false;
  // The index name and server metadata do not affect whether the index enforces
  // the required semantics. Compare every declared option, including partial,
  // sparse, collation, and other options, while ignoring server-only metadata.
  return isDeepStrictEqual(indexOptions(actual), indexOptions(expected));
}

module.exports = { hasSameIndexKey, hasEquivalentIndexDefinition };
