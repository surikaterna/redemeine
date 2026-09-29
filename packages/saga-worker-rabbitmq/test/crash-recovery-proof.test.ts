import { describe, expect, it } from '@jest/globals';
import { expectedMaterial, proveMaterial, proveUnchanged } from '../integration/crashMaterialProof';
import { proveMismatchSignals, proveRecoverySignals } from '../integration/crashRecoveryProof';
import type { CrashSignal } from '../integration/crashIpc';
import { deriveSourceTriggerId } from '@redemeine/saga-runtime';
import { ObjectId, UUID } from 'mongodb';
import { createCounters, createRealTable } from '../integration/fixtures';
import { instanceId } from '../integration/harness';

const sagaKey = createRealTable('crash-proof', createCounters()).definition.sagaKey;
const expected = { sagaId: instanceId(sagaKey, 'crash-order'), sagaKey, partition: 'partition', eventId: 'event',
  sourceTriggerId: deriveSourceTriggerId({ partitionId: 'source-partition', streamId: 'source-stream',
    commitId: 'source-commit', eventIndex: 0 }), sourcePartition: 'source-partition', sourceStream: 'source-stream',
  sourceCommit: 'source-commit', amount: 1, sourceTime: '2026-01-01T00:00:00.000Z' };
function row() {
  return { ...expectedMaterial(expected), _id: new ObjectId(), token: new UUID(),
    createDateTime: new Date('2026-01-01T00:00:01.000Z') };
}

const signals: CrashSignal[] = [
  { kind: 'delivery', messageId: 'source', redelivered: false },
  { kind: 'delivery', messageId: 'source', redelivered: true },
  { kind: 'processed', messageId: 'event', statuses: ['reconciled'] },
  { kind: 'ack', messageId: 'source' },
  { kind: 'delivery', messageId: 'source', attempt: 1, deaths: [{ queue: 'retry', reason: 'expired', count: 1 }] },
  { kind: 'processed', messageId: 'event', statuses: ['reconciled'] },
  { kind: 'ack', messageId: 'source' }
];

describe('offline crash recovery evidence', () => {
  it('validates actual full physical row and compares the exact stored content after recovery', () => {
    const original = [row()];
    expect(proveMaterial(original, expected)).toMatchObject({ physical: 1, intentFacts: 0, stateMatches: true });
    expect(() => proveUnchanged(original, original)).not.toThrow();
    expect(() => proveUnchanged(original, [row(), row()])).toThrow();
    expect(() => proveMaterial([row(), row()], expected)).toThrow();
    const wrong = row(); wrong.events[3]!.payload = { sagaKey, sourceTriggerId: expected.sourceTriggerId, definitionVersion: 1,
      state: { count: 99, seen: ['event'] } };
    expect(() => proveMaterial([wrong], expected)).toThrow();
    expect(() => proveUnchanged(original, [wrong])).toThrow();
    const intent = row(); intent.events.push({ id: 'turn:event:4', version: 4, type: 'saga.intent_recorded.event', payload: {} });
    expect(() => proveMaterial([intent], expected)).toThrow();
    const wrongIdentity = row(); wrongIdentity.sagaTurnIdentity.sourceTriggerId = 'different';
    expect(() => proveMaterial([wrongIdentity], expected)).toThrow();
  });

  it('fails closed on missing ACK, invalid death or attempt, and non-reconciled status', () => {
    expect(proveRecoverySignals(signals, 'source', 'event', 'retry')).toMatchObject({ acks: 2, deathCount: 1 });
    expect(() => proveRecoverySignals(signals.slice(0, -1), 'source', 'event', 'retry')).toThrow();
    const badDeath = structuredClone(signals); badDeath[4] = { kind: 'delivery', messageId: 'source', attempt: 1,
      deaths: [{ queue: 'retry', reason: 'rejected', count: 1 }] };
    expect(() => proveRecoverySignals(badDeath, 'source', 'event', 'retry')).toThrow();
    badDeath[4] = { kind: 'delivery', messageId: 'source', attempt: 2,
      deaths: [{ queue: 'retry', reason: 'expired', count: 1 }] };
    expect(() => proveRecoverySignals(badDeath, 'source', 'event', 'retry')).toThrow();
    badDeath[5] = { kind: 'processed', messageId: 'event', statuses: ['committed'] };
    expect(() => proveRecoverySignals(badDeath, 'source', 'event', 'retry')).toThrow();
  });

  it('requires permanent DLQ confirmation before the third ACK', () => {
    expect(() => proveMismatchSignals([...signals, { kind: 'dead', messageId: 'source' },
      { kind: 'ack', messageId: 'source' }], 'source')).not.toThrow();
    expect(() => proveMismatchSignals([...signals, { kind: 'ack', messageId: 'source' }], 'source')).toThrow();
    expect(() => proveMismatchSignals([...signals, { kind: 'ack', messageId: 'source' },
      { kind: 'dead', messageId: 'source' }], 'source')).toThrow();
  });
});
