async function inspectCollectionIndexes(Model) {
  const modelName = Model?.modelName || 'UnknownModel';
  const collectionName = Model?.collection?.collectionName || Model?.collection?.name;
  const database = Model?.db?.db;

  if (!database || !collectionName) {
    const error = new Error(`Cannot inspect indexes for ${modelName}: its MongoDB connection or collection is unavailable`);
    error.code = 'INDEX_INSPECTION_FAILED';
    throw error;
  }

  try {
    const exists = await database.listCollections({ name: collectionName }, { nameOnly: true }).hasNext();
    if (!exists) {
      const error = new Error(`Cannot inspect indexes for ${modelName}: collection "${collectionName}" does not exist`);
      error.code = 'INDEX_COLLECTION_MISSING';
      throw error;
    }

    return await database.collection(collectionName).listIndexes().toArray();
  } catch (cause) {
    if (cause?.code === 'INDEX_COLLECTION_MISSING') throw cause;
    const error = new Error(`Cannot inspect indexes for ${modelName} collection "${collectionName}": ${cause?.message || 'unknown MongoDB error'}`);
    error.code = 'INDEX_INSPECTION_FAILED';
    error.cause = cause;
    throw error;
  }
}

module.exports = { inspectCollectionIndexes };
