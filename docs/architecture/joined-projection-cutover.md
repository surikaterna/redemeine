# Joined projection cutover — redemeine-zz6h

This is a **manual, forward-only** cutover. There is no automatic migration, historical audit, graph discovery, sharding, or SDK removal. The operator accepts the existing document state and cutoff B; this procedure proves only that approved *current* links can route subsequent events. Do not describe a partial inventory as complete. If completeness cannot be attested, STOP, document the uncovered joins and obtain separate explicit operator acceptance before changing the deployment contract. This gate intentionally has no omission escape hatch.

## Isolate and freeze

For each projection record its exact queue, DLX, document collection, link collection, own-record dedupe collection, transport collection, source UUID, registry manifest ID/generation and approved B. Collections and queue must be exclusive to that projection; do not point two projection workers at a shared old collection or queue. Stop and drain the **old writer** (both document/link writes and queue consumption); prevent its restart. This is an operational stop, not a cryptographic fence. Pause the new writer until seeding and review complete. Verify durable queue/DLX configuration, indexed complete unsliced source range reader, B availability, tail retention through and after B, source anchor B+1, and the accepted-baseline record. If old writer can still write, STOP.

The immutable manifest must declare `joined: true` on every definition with join or reverse-subscribe streams. Its digest must bind that declaration and the deployed executable definition. Joined definitions use `own_record` or `none`, **never** `in_document`. `none` can replay a post-B join update after redelivery; this is not an exactly-once guarantee. The deployment supplies `joinedInventories` to `MongoProjectionTransportStore`, exactly one per joined `(projectionName,generation)` in the queue manifest, with separate `links` and `documents` handles, finite `maxLegacyRows`, ordered `expected` tuples, `approvedBy`, `approvedAt`, and `approvedDigest`. Compute `approvedDigest` with exported `inventoryDigest(manifest, inventory)` on the *frozen* values and have the operator approve that exact digest. Missing, duplicate, changed or unsigned input fails startup. Queues without joined definitions need no inventory.

## Inventory and seed (run with mongosh against the dedicated collections)

The following example seeds **one** tuple. Replace every literal example value and collection name with the approved values; execute once per inventory tuple. Keep a separately reviewed immutable ordered inventory with `aggregateType`, `aggregateId`, `targetDocId` (not a generated lookup). Legacy IDs are `aggregateType:aggregateId`; scoped IDs use a NUL separator, not a colon. Preserve the old rows for rollback/evidence.

```javascript
const projectionName = 'orders';
const generation = 'g1';
const aggregateType = 'Customer';
const aggregateId = 'customer-17';
const targetDocId = 'Order:42';
const maxLegacyRows = 100; // operator-approved bound, never inferred from the database
const links = db.getCollection('orders_links');
const documents = db.getCollection('orders_documents');
const legacyId = `${aggregateType}:${aggregateId}`;
const _id = [projectionName, generation, aggregateType, aggregateId].join('\u0000');
const legacy = links.findOne({ _id: legacyId });
if (!legacy || legacy.targetDocId !== targetDocId) throw Error('legacy link missing/conflicting');
const target = documents.findOne({ _id: targetDocId });
if (!target || target.state == null || target.deleted === true || target.tombstone === true)
  throw Error('target missing/tombstoned');
const seed = { _id, aggregateType, aggregateId, targetDocId,
  createdAt: new Date().toISOString(), v2Revision: 0 };
const before = links.findOne({ _id });
if (before && (before.aggregateType !== aggregateType || before.aggregateId !== aggregateId ||
    before.targetDocId !== targetDocId || before.v2Revision !== 0 ||
    typeof before.createdAt !== 'string' || Number.isNaN(Date.parse(before.createdAt))))
  throw Error('conflicting preexisting scoped row');
links.updateOne({ _id }, { $setOnInsert: seed }, { upsert: true });
const actual = links.findOne({ _id });
const expected = before || seed;
if (!actual || Object.keys(expected).some(k => actual[k] !== expected[k]) ||
    Object.keys(actual).length !== Object.keys(expected).length)
  throw Error('scoped link insert conflict/unknown outcome');
```

For the full inventory, compare **exact sets** of `(legacyId,targetDocId)` from `links.find({_id: {$regex: '^[^\\x00]+$'}}, {_id:1,targetDocId:1}).limit(maxLegacyRows+1)` with the approved tuple set. Reject if the cursor yields more than `maxLegacyRows`, if a legacy ID is unexpected, a target differs, or any expected ID is absent. Then individually verify each scoped row has exact `_id`, `aggregateType`, `aggregateId`, `targetDocId`, ISO string `createdAt`, `v2Revision:0` and an existing non-tombstoned target document. Do not delete, rename, overwrite, or silently skip old links. Do not use an unbounded collection scan; the gate does a bounded legacy-key query on the dedicated collection only. If the legacy-key ID pattern cannot faithfully represent the approved set (for example `:` collisions), STOP and resolve inventory externally.

## Activate, restart, rollback

Before Rabbit `checkQueue`/`consume` or tail `bootstrap`, the worker verifies binding and accepted baseline, reviews all scoped rows and bounded legacy rows on first adoption, then inserts an immutable majority-written `joined_adoption:<queueId>` transport record with registry identity and inventory digests using insert-only CAS/read-back. Do not start workers concurrently with seed or old writer. If the process dies after adoption but before bootstrap, retrying the same queue/manifest/digest is idempotent; the operational old-writer stop remains mandatory. Changed manifest or inventory fails even on restart. After adoption, scoped link mutations and unsubscribes from the new writer are legitimate: restarts check the adoption identity, **not** the original live links. To roll back, stop new consumption/tail and inspect source coverage and actual documents/links before deciding on the old writer; never let old and new writers overlap. No historical correctness certification is implied.

`dedupeCollection` holds `own_record` dedupe rows. Document `sourceProgress` is the `in_document` per-source marker (not allowed for joined definitions). The separate transport coverage collection tracks contiguous queue/source progress for tail dispatch; it does **not** prove that every target was updated. Missing legacy links must fail *before* a no-target `own_record` row or coverage can be written. `none` supplies neither of those dedupe guarantees; duplicate deliveries can repeat state changes. Record B, manifest/digest, observed inventory counts, worker start result and any rollback evidence in the release receipt.
