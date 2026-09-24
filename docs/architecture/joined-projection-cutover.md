# Joined projection cutover — redemeine-zz6h

This is a **manual, forward-only** cutover. Existing projections have **documents only**: there is no persisted old link collection or projection progress to migrate, discover, compare, or delete. Existing projection code/domain rules derive joins. An operator must review those rules and their domain data, approve a complete finite tuple inventory `(aggregateType, aggregateId, targetDocId)` for the existing documents, and accept the existing state and cutoff B. If completeness cannot be established, **STOP**; absence of a link is not evidence of an empty inventory. No automatic migration, historical verification, bulk document rewrite, sharding, or SDK removal is implied.

## Isolate and freeze

For each projection record its exact queue/DLX, existing document collection, **new empty** link, progress/dedupe, transport and read-only approval collections, source UUID, registry generation/manifest ID and accepted B. The document/link/progress/transport collections and queue are dedicated to this projection; only the approval registry may contain records for multiple queues. Stop/drain the old **document writer** and revoke its restart/write credentials before admission. This is an operational stop, not a Mongo transaction fence against later independent writes. Verify durable queue/DLX topology, complete indexed source reader, retained B and post-B tail, start anchor B+1 and accepted-baseline prerequisites. Freeze seeding and both writers during initial snapshot verification.

The immutable manifest marks every joined definition `joined: true`. Its configuration digest binds the deployed join rules; joined strategies are `own_record` or `none`, never `in_document`. Provision the write-once `joined_approval:<queueId>` under a deployment identity with **find/insert only** on the separate approval collection. Worker credentials have find only there, and necessary read/write/index/transaction permissions on their dedicated collections. The worker supplies physical Mongo handles, not a self-approved inventory. Approval binds the queue, manifest, generations, namespaces, approved tuples and finite bound. For no joined definitions, no inventory is required.

## Review, seed and reconcile using mongosh

Run with reviewed values against the dedicated database. Operator credentials need read/insert/update on the new link collection, read on existing documents, and read/insert only on approvals. Replace `inventory` with **all** tuples derived by review of the deployed projection source code and domain inputs; record a durable review reference. A genuinely empty inventory needs the explicit `knownEmpty` flag and `emptyInventoryReference` in the signed-off, write-once approval. No old link lookup exists.

```javascript
const projectionName = 'orders';
const generation = 'g1';
const queueId = 'orders.queue';
const manifestId = 'sha256:REPLACE_WITH_ACTUAL_MANIFEST_DIGEST';
const registryGeneration = 'g1';
const inventory = [{ aggregateType: 'Customer', aggregateId: 'customer-17', targetDocId: 'Order:42' }];
const reviewReference = 'REPLACE_WITH_CODE_AND_DOMAIN_INVENTORY_REVIEW';
const knownEmpty = false; // set true ONLY after approving an actually empty, complete code/domain inventory
const maxLinkRows = 100; // finite operator bound >= inventory.length, never inferred from Mongo
const links = db.getCollection('orders_links'); // NEW dedicated collection
const progress = db.getCollection('orders_dedupe'); // NEW dedicated collection
const transport = db.getCollection('orders_transport'); // NEW dedicated collection
const documents = db.getCollection('orders_documents'); // EXISTING documents, not rewritten
const approvals = db.getCollection('joined_approvals'); // deployment insert-only; worker read-only
const approvalId = `joined_approval:${queueId}`;
function equal(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function exact(row, keys) { return row && equal(Object.keys(row).sort(), [...keys].sort()); }
function valid(row, tuple) {
  return exact(row, ['_id','aggregateType','aggregateId','targetDocId','createdAt','v2Revision']) &&
    row.aggregateType === tuple.aggregateType && row.aggregateId === tuple.aggregateId &&
    row.targetDocId === tuple.targetDocId && typeof row.createdAt === 'string' &&
    !Number.isNaN(Date.parse(row.createdAt)) && new Date(row.createdAt).toISOString() === row.createdAt &&
    row.v2Revision === 0;
}
if (!Array.isArray(inventory) || !Number.isSafeInteger(maxLinkRows) || maxLinkRows < inventory.length ||
    maxLinkRows > 100000 || !reviewReference.trim() || (inventory.length === 0 && !knownEmpty))
  throw Error('unapproved, unknown, or unbounded code-derived link inventory');
if (transport.findOne({ _id: `joined_adoption:${queueId}` })) throw Error('already adopted; do not reseed live links');
const prior = approvals.findOne({ _id: approvalId });
if (!prior && [links, progress, transport].some(collection => collection.countDocuments({}) !== 0))
  throw Error('new link/progress/transport collections must be empty before initial seed');
if (progress.countDocuments({}) !== 0) throw Error('progress exists before joined activation');
const expectedIds = new Map();
for (const tuple of inventory) {
  if (!exact(tuple, ['aggregateType','aggregateId','targetDocId']) ||
      [tuple.aggregateType, tuple.aggregateId, tuple.targetDocId].some(value =>
        typeof value !== 'string' || !value.length || value.includes('\u0000')))
    throw Error('invalid code-derived tuple');
  const _id = [projectionName, generation, tuple.aggregateType, tuple.aggregateId].join('\u0000');
  if (expectedIds.has(_id)) throw Error('duplicate scoped tuple');
  expectedIds.set(_id, tuple);
  const target = documents.findOne({ _id: tuple.targetDocId });
  if (!target || target.state == null || target.deleted === true || target.tombstone === true)
    throw Error('existing target missing/tombstoned');
  const seed = { _id, aggregateType: tuple.aggregateType, aggregateId: tuple.aggregateId,
    targetDocId: tuple.targetDocId, createdAt: new Date().toISOString(), v2Revision: 0 };
  const before = links.findOne({ _id });
  if (before && !valid(before, tuple)) throw Error('conflicting preexisting scoped row');
  links.updateOne({ _id }, { $setOnInsert: seed }, { upsert: true });
  const after = links.findOne({ _id });
  if (!valid(after, tuple) || !equal(after, before || seed)) throw Error('seed conflict/unknown insert outcome');
}
const rows = links.find({}).sort({ _id: 1 }).hint({ _id: 1 }).limit(maxLinkRows + 1).toArray();
if (rows.length !== expectedIds.size || rows.length > maxLinkRows) throw Error('missing/extra/overflow scoped links');
for (const row of rows) {
  const tuple = expectedIds.get(row._id);
  if (!tuple || !valid(row, tuple)) throw Error('unknown/unscoped/malformed link');
  expectedIds.delete(row._id);
}
if (expectedIds.size) throw Error('missing approved scoped link');
const approvedInventory = { projectionName, generation, linkNamespace: `${db.getName()}.orders_links`,
  documentNamespace: `${db.getName()}.orders_documents`, expected: inventory, maxLinkRows,
  ...(inventory.length === 0 ? { knownEmpty: true, emptyInventoryReference: reviewReference } : {}) };
const base = { _id: approvalId, kind: 'joined_approval', queueBindingId: queueId, manifestId,
  registryGeneration, approvalNamespace: `${db.getName()}.joined_approvals`,
  transportNamespace: `${db.getName()}.orders_transport`, approvedBy: 'REPLACE_WITH_OPERATOR',
  approvedAt: prior?.approvedAt || new Date().toISOString(), inventories: [approvedInventory] };
const approval = { ...base, digest: 'sha256:' + require('crypto').createHash('sha256')
  .update(JSON.stringify(base)).digest('hex') };
if (prior && !equal(prior, approval)) throw Error('conflicting write-once approval');
if (!prior) {
  try { approvals.insertOne(approval, { writeConcern: { w: 'majority' } }); }
  catch (error) { if (error.code !== 11000) throw error; } // competing provisioner must read back equal
}
if (!equal(approvals.findOne({ _id: approvalId }), approval)) throw Error('approval insert conflict');
printjson({ approvalId, digest: approval.digest, scopedRows: rows.length,
  targetCount: new Set(inventory.map(tuple => tuple.targetDocId)).size });
```

The code-derived inventory is approved **before** bootstrap and Rabbit consumption; a zero-row approval requires the attestation *and* a truly empty new link collection. The worker's majority/snapshot transaction independently scans every row of that collection using `_id` order and `maxLinkRows+1`; unknown scoped/unscoped/other-generation/malformed rows, missing links and missing targets fail before admission. It atomically records `joined_adoption:<queueId>` with the approved digest. A snapshot is not an old-writer fence: stop/revoke the previous document writer. Do not rerun this seed procedure after activation; on restart the worker checks the persisted approval/namespace/manifest identity without requiring the original scoped links to remain live after legitimate subscriptions or unsubscriptions.

## Progress, rollback and receipt

`dedupeCollection` is the **new** dedicated progress collection. Its `own_record` rows hold per-projection/generation/source commit progress. There are no pre-cutover progress rows to copy. For `in_document`, new `sourceProgress` resides on documents (joined `in_document` is forbidden); for `none`, no projection dedupe is recorded and duplicate post-B events may replay. **Even for `none` and `in_document`**, Mongo store startup still creates/checks the unique non-TTL own-progress index and probes transactions on `dedupeCollection`; it does not mean pre-existing progress was present. Separate transport coverage tracks contiguous queue/source tail dispatch, *not* proof that every target was updated. A rejected inventory must write neither coverage nor own-record progress.

To roll back, stop the new consumer/tail, preserve B, coverage, approved inventory and current documents/links, then decide on a controlled old-writer restart without overlapping writers. Do not delete the new approval or claim historical state verification. Record namespace identities, code/domain review reference, target count, B, manifest/digest, worker outcome and observed post-B progress in the release receipt.
