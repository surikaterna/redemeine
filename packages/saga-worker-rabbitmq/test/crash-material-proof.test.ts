import { describe, expect, it } from '@jest/globals';
import { ObjectId, UUID } from 'mongodb';
import { deriveSourceTriggerId } from '@redemeine/saga-runtime';
import { createCounters, createRealTable } from '../integration/fixtures';
import { instanceId } from '../integration/harness';
import { expectedMaterial, proveMaterial, proveUnchanged } from '../integration/crashMaterialProof';

const sourcePartition = 'source-fixture';
const sagaKey = createRealTable('crash-proof', createCounters()).definition.sagaKey;
const expected = { sagaId: instanceId(sagaKey, 'crash-order'), sagaKey, partition: 'saga-fixture',
  eventId: 'crash-event', sourceTriggerId: deriveSourceTriggerId({ partitionId: sourcePartition,
    streamId: 'crash-source-stream', commitId: 'crash-source-commit', eventIndex: 0 }),
  sourcePartition, sourceStream: 'crash-source-stream', sourceCommit: 'crash-source-commit',
  amount: 1, sourceTime: '2026-01-01T00:00:00.000Z' };

function fixture() {
  return { ...expectedMaterial(expected), _id: new ObjectId(), token: new UUID(),
    createDateTime: new Date('2026-01-01T00:00:01.000Z') };
}

describe('complete physical turn fixture', () => {
  it('checks exact turn content, intent absence, and full BSON before/after', () => {
    const row = fixture();
    expect(proveMaterial([row], expected)).toMatchObject({ physical: 1, intentFacts: 0, stateMatches: true });
    expect(() => proveUnchanged([row], [row])).not.toThrow();
    expect(() => proveUnchanged([row], [row, row])).toThrow();
    expect(() => proveUnchanged([row], [{ ...row, _id: new ObjectId() }])).toThrow();
  });

  it.each(['sagaType', 'createdAt', 'policySha256', 'aggregateType', 'aggregateId',
    'correlationId', 'observedAt', 'recordedAt', 'correlation', 'state', 'metadata',
    'extra', 'extraIntent', 'missingStateFact', 'wrongId'] as const)('rejects mutated %s', (mutation) => {
    const row = fixture();
    const payload = row.events[0]!.payload as Record<string, unknown>;
    const definition = row.events[1]!.payload as Record<string, unknown>;
    const observation = (row.events[2]!.payload as { record: Record<string, unknown> }).record;
    const business = row.events[3]!.payload as Record<string, unknown>;
    if (mutation === 'sagaType' || mutation === 'createdAt') payload[mutation] = 'wrong';
    if (mutation === 'policySha256') definition.policySha256 = 'f'.repeat(64);
    if (mutation === 'aggregateType' || mutation === 'aggregateId' || mutation === 'correlationId' ||
      mutation === 'observedAt' || mutation === 'metadata') observation[mutation] = 'wrong';
    if (mutation === 'recordedAt' || mutation === 'correlation' || mutation === 'state') business[mutation] = 'wrong';
    if (mutation === 'extra') business.unexpected = true;
    if (mutation === 'extraIntent') row.events.push({ ...row.events[3]!, type: 'saga.intent_recorded.event' });
    if (mutation === 'missingStateFact') row.events.splice(3, 1);
    if (mutation === 'wrongId') row.id = 'wrong';
    expect(() => proveMaterial([row], expected)).toThrow();
  });
});
