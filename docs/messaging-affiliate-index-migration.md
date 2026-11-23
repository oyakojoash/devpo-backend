# Customer–Affiliate Messaging Index Rollout Plan

This is an operator runbook only. The commands below were not executed. **Do not connect this task's test process to MongoDB.** Run the preflight section manually against the intended database and review results before scheduling the cutover.

## Preconditions

- Confirm the MongoDB deployment supports transactions, take and verify a restorable backup, and schedule a maintenance window.
- Confirm the collection name (Mongoose normally uses `conversations`) and database before running commands.
- The repository pins the Node.js MongoDB driver and Mongoose versions, but does not declare the MongoDB server version or Atlas cluster version. Do not infer the server version from the driver version.
- MongoDB's documented same-key-pattern coexistence exception covers unique sparse and unique non-sparse indexes beginning with MongoDB 5.0. The documentation does not establish that the exact full-unique and partial-unique Customer–Merchant indexes below can coexist. Do not build them concurrently; treat coexistence as unverified unless separately proven in a disposable deployment matching the exact target server version. See [MongoDB sparse indexes](https://www.mongodb.com/docs/manual/core/index-sparse/) and [partial indexes](https://www.mongodb.com/docs/manual/core/index-partial/).
- The new application rejects a full unique `{ customerId: 1, merchantId: 1 }` index regardless of its name. Keep all new application instances stopped until that obsolete index is removed and the new required indexes are present.

## Read-only preflight

These `mongosh` expressions only inspect data and index metadata. They do not create, remove, or modify anything.

```javascript
const c = db.getCollection('conversations');

// Inventory all indexes, including names, keys, unique options, and partial filters.
c.getIndexes();

// Duplicate Customer–Merchant pairs among records whose participant IDs are ObjectIds.
c.aggregate([
  { $match: { $expr: { $and: [ { $eq: [ { $type: '$customerId' }, 'objectId' ] }, { $eq: [ { $type: '$merchantId' }, 'objectId' ] } ] } } },
  { $group: { _id: { customerId: '$customerId', merchantId: '$merchantId' }, count: { $sum: 1 }, ids: { $push: '$_id' } } },
  { $match: { count: { $gt: 1 } } }
]);

// Duplicate Customer–Affiliate pairs among records whose participant IDs are ObjectIds.
c.aggregate([
  { $match: { $expr: { $and: [ { $eq: [ { $type: '$customerId' }, 'objectId' ] }, { $eq: [ { $type: '$affiliateId' }, 'objectId' ] } ] } } },
  { $group: { _id: { customerId: '$customerId', affiliateId: '$affiliateId' }, count: { $sum: 1 }, ids: { $push: '$_id' } } },
  { $match: { count: { $gt: 1 } } }
]);

// Malformed participant combinations: neither recipient, both recipients,
// missing/non-ObjectId customerId, or a non-ObjectId recipient value.
c.find({ $expr: { $or: [
  { $ne: [ { $type: '$customerId' }, 'objectId' ] },
  { $eq: [ { $eq: [ { $type: '$merchantId' }, 'objectId' ] }, { $eq: [ { $type: '$affiliateId' }, 'objectId' ] } ] },
  { $and: [ { $ne: [ { $type: '$merchantId' }, 'missing' ] }, { $ne: [ { $type: '$merchantId' }, 'null' ] }, { $ne: [ { $type: '$merchantId' }, 'objectId' ] } ] },
  { $and: [ { $ne: [ { $type: '$affiliateId' }, 'missing' ] }, { $ne: [ { $type: '$affiliateId' }, 'null' ] }, { $ne: [ { $type: '$affiliateId' }, 'objectId' ] } ] }
] } });

// Inspect every record containing affiliateId, including records with a null or malformed value.
c.find({ affiliateId: { $exists: true } });
```

Stop if either duplicate aggregation returns rows, malformed conversations are found, or any existing Affiliate records are not understood. Review each unexpected record and its messages with the application/data owner. Decide whether to preserve it, repair it, or archive it under an explicitly approved plan; do not silently delete or rewrite it as part of index rollout. Also inspect `getIndexes()` for any full unique index with key `{ customerId: 1, merchantId: 1 }`, whatever its name.

## Expected Conversation indexes

| Name | Key | Options |
| --- | --- | --- |
| `uniq_customer_merchant_conversation_v2` | `{ customerId: 1, merchantId: 1 }` | `unique: true`, `partialFilterExpression: { merchantId: { $type: 'objectId' } }` |
| `uniq_customer_affiliate_conversation` | `{ customerId: 1, affiliateId: 1 }` | `unique: true`, `partialFilterExpression: { affiliateId: { $type: 'objectId' } }` |
| `customer_conversation_list` | `{ customerId: 1, updatedAt: -1, _id: -1 }` | non-unique |
| `merchant_conversation_list` | `{ merchantId: 1, updatedAt: -1, _id: -1 }` | non-unique |
| `affiliate_conversation_list` | `{ affiliateId: 1, updatedAt: -1, _id: -1 }` | non-unique |

The existing `_id_` index remains. Preserve all existing message indexes; this conversation-index rollout does not change them. The obsolete index is any **full, unique** `{ customerId: 1, merchantId: 1 }` index with no partial filter. The partial v2 index above is not obsolete.

The exact legacy index being replaced is any index (commonly named `uniq_customer_merchant_conversation`) with key `{ customerId: 1, merchantId: 1 }`, `unique: true`, and no `partialFilterExpression`. Its actual name and options must be confirmed with `getIndexes()`; do not identify it by name alone. The replacement specification is `uniq_customer_merchant_conversation_v2`, key `{ customerId: 1, merchantId: 1 }`, `unique: true`, and `partialFilterExpression: { merchantId: { $type: 'objectId' } }`.

## Maintenance-window transition (mutating)

The following commands are an operator runbook only; **they are documented, not executed here**. The transition deliberately does not depend on the old full unique index and new partial unique index coexisting.

1. Take and verify a restorable backup. Pause all messaging writes at the ingress/application layer and drain in-flight requests. Stop **all** old backend instances, workers, scheduled processes, and other writers that can create or update conversations. Keep writes paused and all old writers stopped until readiness succeeds.
2. While writes are paused, rerun the read-only duplicate-pair and malformed-record checks above. Resolve all findings through a separately reviewed data plan. Inspect the conversation indexes and confirm the exact legacy index specification and its actual name.
3. Drop only the confirmed full unique Customer–Merchant index. Do not drop any other index. At this point there is temporarily no Customer–Merchant unique index, so the write pause is mandatory; do not permit any application or operator writes until replacement indexes have been created and verified.

```javascript
// Use the actual legacy name verified in the preceding read-only inspection.
c.dropIndex('<verified-legacy-index-name>');
```

4. With writes still paused, create the replacement Customer–Merchant and Customer–Affiliate unique indexes and all required conversation-list indexes using the exact table specifications. Existing exact customer/merchant list indexes may be left in place. Preserve all message indexes.

```javascript
c.createIndex(
  { customerId: 1, merchantId: 1 },
  { unique: true, name: 'uniq_customer_merchant_conversation_v2', partialFilterExpression: { merchantId: { $type: 'objectId' } } }
);
c.createIndex(
  { customerId: 1, affiliateId: 1 },
  { unique: true, name: 'uniq_customer_affiliate_conversation', partialFilterExpression: { affiliateId: { $type: 'objectId' } } }
);
c.createIndex(
  { customerId: 1, updatedAt: -1, _id: -1 },
  { name: 'customer_conversation_list' }
);
c.createIndex(
  { merchantId: 1, updatedAt: -1, _id: -1 },
  { name: 'merchant_conversation_list' }
);
c.createIndex(
  { affiliateId: 1, updatedAt: -1, _id: -1 },
  { name: 'affiliate_conversation_list' }
);
```

5. Inspect `c.getIndexes()` and `db.getCollection('messages').getIndexes()`. Confirm exact names, ordered key directions, `unique` values, partial filters, and all required indexes. Confirm that no full unique Customer–Merchant index remains. If any index build fails or any definition differs, keep writes and all old application instances stopped and resolve the issue; do not resume traffic.
6. Start only the new backend version. Its schemas set `autoCreate: false` and `autoIndex: false` for Conversation, Message, and Order; its startup readiness checks inspect existing collections/indexes and fail closed. Confirm readiness succeeds. Do not use automatic model initialization or a fallback to create missing collections/indexes.
7. Resume messaging writes only after index verification and new-version readiness both succeed. If a functional write smoke test is required, perform it only after the new unique indexes are verified and with a controlled account under the approved maintenance procedure.

Old and new application versions must not overlap during this cutover. The interval after dropping the legacy unique index and before verifying its replacement has no Customer–Merchant unique constraint; pausing writes and stopping every old/new writer is the compensating control for that interval. The documented unique sparse/non-sparse coexistence exception does not prove coexistence for these partial-index specifications.

## Rollback constraints

If application rollback is needed after Affiliate conversations exist, first stop messaging writes and keep the new partial indexes. Do not restore the old full unique index: Affiliate conversations omit `merchantId`, so multiple Affiliate conversations for one Customer may collide on the old index's missing/null key. Restoring it requires a separately reviewed cleanup or archival plan, verified absence of conflicts, and an explicit decision about preserving Affiliate conversation history. Keep all application writers stopped until the rollback index and data state are reviewed. No rollback should drop indexes or discard records by assumption.

No database data rewrite is required solely to add the optional `affiliateId` field to valid existing Customer–Merchant records. No migration, index operation, or database write is performed by this document.
