# Joined projection cutover — redemeine-zz6h

This is a **manual, forward-only** cutover. There is no automatic migration, historical audit, graph discovery, sharding, or SDK removal. The operator accepts the existing document state and cutoff B; this procedure proves only that approved *current* links can route subsequent events. Do not describe a partial inventory as complete. If completeness cannot be attested, STOP, document the uncovered joins and obtain separate explicit operator acceptance before changing the deployment contract. This gate intentionally has no omission escape hatch.

## Isolate and freeze

For each projection record its exact queue, DLX, document collection, link collection, own-record dedupe collection, transport collection, separate approval collection, source UUID, registry manifest ID/generation and approved B. Collections and queue must be exclusive to that projection (except the read-only approval registry); do not point two projection workers at a shared old collection or queue. Stop and drain the **old writer** (both document/link writes and queue consumption); prevent its restart. This is an operational stop, not a cryptographic fence. Pause the new writer until seeding and review complete. Verify durable queue/DLX configuration, indexed complete unsliced source range reader, B availability, tail retention through and after B, source anchor B+1, and the accepted-baseline record. If old writer can still write, STOP.

The immutable manifest must declare `joined: true` on every definition with join or reverse-subscribe streams. Its digest must bind that declaration and the deployed executable definition. Joined definitions use `own_record` or `none`, **never** `in_document`. `none` can replay a post-B join update after redelivery. Provision a durable write-once `joined_approval:<queueId>` record in a **separate** approval collection with restricted **deployment** credentials. Worker credentials must have read-only access to approvals but may write to the separate transport collection. Supply the real `links`/`documents` Mongo handles in `joinedInventories` and the read-only `joinedApprovals` handle; workers cannot create or derive approval from deployment config. Approval binds queue, manifest, registry generation, approval/transport/document/link database and collection namespaces, exact ordered tuples and finite bound. Use a separate document/link/transport collection and queue for every projection; without joined definitions no approval is needed.

## Inventory and seed (run with mongosh against the dedicated collections)

Run the following in `mongosh` with operator credentials and reviewed explicit values. Replace the example list with the **entire finite inventory**, preserving its order. Use the actual physical `db.getName()` and collection names. The count bound includes both legacy and scoped rows. Do not manufacture missing legacy links or target documents. Approval is installed only after all seeds and reconciliation succeed.

```javascript
const projectionName = 'orders';
const generation = 'g1';
const queueId = 'orders.queue';
const manifestId = 'sha256:REPLACE_WITH_ACTUAL_MANIFEST_DIGEST';
const registryGeneration = 'g1';
const inventory = [{ aggregateType: 'Customer', aggregateId: 'customer-17', targetDocId: 'Order:42' }];
const maxLinkRows = 100; // approved finite bound >= 2 * inventory.length; never inferred
const links = db.getCollection('orders_links');
const documents = db.getCollection('orders_documents');
const approvals = db.getCollection('joined_approvals'); // deployment write role; worker read-only
function equal(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function fields(row, names) { return equal(Object.keys(row).sort(), [...names].sort()); }
function valid(row, tuple, scoped) {
  return row && fields(row, ['_id','aggregateType','aggregateId','targetDocId','createdAt',
    ...(scoped ? ['v2Revision'] : [])]) && row.aggregateType === tuple.aggregateType &&
    row.aggregateId === tuple.aggregateId && row.targetDocId === tuple.targetDocId &&
    typeof row.createdAt === 'string' && !Number.isNaN(Date.parse(row.createdAt)) &&
    (!scoped || row.v2Revision === 0);
}
if (!Number.isSafeInteger(maxLinkRows) || maxLinkRows < 2 * inventory.length || maxLinkRows > 100000)
  throw Error('invalid finite bound');
const expectedIds = new Map();
for (const tuple of inventory) {
  const legacyId = `${tuple.aggregateType}:${tuple.aggregateId}`;
  const _id = [projectionName, generation, tuple.aggregateType, tuple.aggregateId].join('\u0000');
  if (expectedIds.has(legacyId) || expectedIds.has(_id)) throw Error('ambiguous inventory');
  expectedIds.set(legacyId, [tuple, false]); expectedIds.set(_id, [tuple, true]);
  if (!valid(links.findOne({ _id: legacyId }), tuple, false)) throw Error('legacy mismatch');
  const target = documents.findOne({ _id: tuple.targetDocId });
  if (!target || target.state == null || target.deleted === true || target.tombstone === true)
    throw Error('target missing/tombstoned');
  const seed = { _id, aggregateType: tuple.aggregateType, aggregateId: tuple.aggregateId,
    targetDocId: tuple.targetDocId, createdAt: new Date().toISOString(), v2Revision: 0 };
  const before = links.findOne({ _id });
  if (before && !valid(before, tuple, true)) throw Error('conflicting scoped row');
  links.updateOne({ _id }, { $setOnInsert: seed }, { upsert: true });
  const after = links.findOne({ _id });
  if (!valid(after, tuple, true) || !equal(after, before || seed)) throw Error('unknown seed outcome');
}
const rows = links.find({}).sort({ _id: 1 }).hint({ _id: 1 }).limit(maxLinkRows + 1).toArray();
if (rows.length !== expectedIds.size || rows.length > maxLinkRows) throw Error('missing/extra/overflow link');
for (const row of rows) {
  const match = expectedIds.get(row._id);
  if (!match || !valid(row, match[0], match[1])) throw Error('unknown/malformed link');
  expectedIds.delete(row._id);
}
if (expectedIds.size) throw Error('missing approved link');
const prior = approvals.findOne({ _id: `joined_approval:${queueId}` });
const base = { _id: `joined_approval:${queueId}`, kind: 'joined_approval', queueBindingId: queueId,
  manifestId, registryGeneration, approvalNamespace: `${db.getName()}.joined_approvals`,
  transportNamespace: `${db.getName()}.orders_transport`,
  approvedBy: 'REPLACE_WITH_OPERATOR', approvedAt: prior?.approvedAt || new Date().toISOString(), inventories: [{
    projectionName, generation, linkNamespace: `${db.getName()}.orders_links`,
    documentNamespace: `${db.getName()}.orders_documents`, expected: inventory, maxLinkRows }] };
const digest = 'sha256:' + require('crypto').createHash('sha256').update(JSON.stringify(base)).digest('hex');
const approval = { ...base, digest };
if (prior && !equal(prior, approval)) throw Error('conflicting write-once approval');
approvals.updateOne({ _id: base._id }, { $setOnInsert: approval }, { upsert: true, writeConcern: { w: 'majority' } });
if (!equal(approvals.findOne({ _id: base._id }), approval)) throw Error('approval insert conflict');
printjson({ approvalId: base._id, digest, rows: rows.length, targetCount: new Set(inventory.map(x => x.targetDocId)).size });
```

Legacy IDs are `aggregateType:aggregateId`; scoped IDs use a literal NUL separator. This script does not delete/overwrite legacy rows. The worker independently re-enumerates **all** rows of only this dedicated collection with `_id` index order and `maxLinkRows+1` cap in a Mongo snapshot transaction. It rejects unknown scoped/legacy/other-generation rows, missing/malformed rows and missing targets. Stop if the legacy ID format is ambiguous. The approval is an operator-issued durable identity, **not** a signature: enforce restricted deployment/worker DB permissions, independent approval review and write-once provisioning.

## Activate, restart, rollback

Before Rabbit `checkQueue`/`consume` or tail `bootstrap`, the worker checks the immutable binding, accepted baseline and majority-visible operator approval and matches the **actual Mongo handles** to approved namespaces. Initial verification reads approval, all link rows and targets and inserts `joined_adoption:<queueId>` in one snapshot transaction with majority commit. Concurrent adopters reconcile only the identical majority-visible approval/adoption; different approvals fail. A snapshot transaction does **not** fence later independent inserts or a still-running old writer: stop/revoke the old writer and freeze seeding/new writer before initial admission. A crash after adoption but before bootstrap can retry idempotently under the same operational freeze. On restart the worker checks approval, manifest and namespaces against adoption but does not rescan links changed by legitimate new subscriptions/unsubscriptions. For rollback, stop new consumption/tail, inspect coverage and documents/links, and never overlap writers. No historical correctness certification is implied.

`dedupeCollection` holds `own_record` dedupe rows. Document `sourceProgress` is the `in_document` per-source marker (not allowed for joined definitions). The separate transport coverage collection tracks contiguous queue/source progress for tail dispatch; it does **not** prove that every target was updated. Missing legacy links must fail *before* a no-target `own_record` row or coverage can be written. `none` supplies neither of those dedupe guarantees; duplicate deliveries can repeat state changes. Record B, manifest/digest, observed inventory counts, worker start result and any rollback evidence in the release receipt.
