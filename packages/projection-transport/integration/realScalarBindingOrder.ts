import assert from 'node:assert/strict';
import { createProjectionDispatchBindingProof, matchesProjectionDispatchBinding } from '@redemeine/projection-runtime-core';
import type { Db, MongoClient } from 'mongodb';
import { MongoProjectionTransportStore, projectionQueueRegistryDigest, type ProjectionTransportDocument } from '../src';
import { joinBindingConfiguration } from './realJoinBinding';

export async function runScalarBindingOrder(db: Db, mongoClient: MongoClient) {
  const sourceA = '00000000-0000-4000-8000-000000000000';
  const sourceB = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
  const { manifestId: _original, ...defaultManifest } = joinBindingConfiguration(false, true, sourceA).manifest;
  const anchors = Object.assign(Object.create(null) as Record<string, number>, { [sourceB]: 2, [sourceA]: 1 });
  const payload = { ...defaultManifest, sourceStartAnchors: anchors };
  const manifest = { ...payload, manifestId: projectionQueueRegistryDigest(payload) };
  const reordered = { ...manifest, sourceStartAnchors: { [sourceA]: 1, [sourceB]: 2 } };
  const proof = createProjectionDispatchBindingProof(manifest);
  assert(matchesProjectionDispatchBinding({ version: 1, manifest: reordered }, { version: 1, manifest }));
  assert.equal(JSON.stringify(proof.manifest), JSON.stringify(manifest));
  const collection = db.collection<ProjectionTransportDocument>('bindings');
  const store = new MongoProjectionTransportStore({ collection, mongoClient, manifest });
  assert.equal((await store.bindImmutableManifest(manifest)).status, 'bound');
  assert.equal((await store.bindImmutableManifest(reordered)).status, 'matches');
  const row = await collection.findOne({ kind: 'binding' });
  assert(row?.kind === 'binding');
  // The pre-set binder compares this BSON document to its configured manifest with JSON.stringify.
  assert.equal(JSON.stringify(row.manifest), JSON.stringify(manifest));
  assert.equal(JSON.stringify(row.binding.identity), JSON.stringify(manifest.identity));
  assert.equal((await store.bindImmutableManifest({ ...manifest,
    definitions: manifest.definitions.map((entry) => ({ ...entry, sourceSelectors: [...entry.sourceSelectors].reverse() })) })).status, 'conflict');
}
