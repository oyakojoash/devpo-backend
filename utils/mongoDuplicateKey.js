function parseDuplicateKeyIndexName(message) {
  if (typeof message !== 'string' || message.length === 0) return null;

  const envelope = /^E11000 duplicate key error collection: (\S+) index:\s+(.+?)\s+dup key:\s*(\{[\s\S]*\})$/.exec(message);
  if (!envelope) return null;

  const indexMarkers = [...message.matchAll(/(?:^|\s)index:\s*/g)];
  if (indexMarkers.length !== 1) return null;

  const indexStart = indexMarkers[0].index + indexMarkers[0][0].length;
  const remaining = message.slice(indexStart);
  const delimiters = [...remaining.matchAll(/\s+dup key:/g)];
  if (delimiters.length !== 1) return null;

  const indexName = envelope[2].trim();
  return indexName || null;
}

function hasExpectedDuplicateKey(error, { keyPattern, indexName }) {
  if (error?.code !== 11000) return false;

  if (error.keyPattern !== undefined && error.keyPattern !== null) {
    if (typeof error.keyPattern !== 'object' || Array.isArray(error.keyPattern)) return false;
    const actualFields = Object.keys(error.keyPattern);
    const expectedFields = Object.keys(keyPattern);
    return actualFields.length === expectedFields.length &&
      expectedFields.every((field) => Object.hasOwn(error.keyPattern, field) && error.keyPattern[field] === keyPattern[field]);
  }

  return parseDuplicateKeyIndexName(error.message) === indexName;
}

module.exports = { hasExpectedDuplicateKey, parseDuplicateKeyIndexName };
