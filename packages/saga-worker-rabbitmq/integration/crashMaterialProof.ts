import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { BSON, ObjectId, UUID } from 'mongodb';
import { deriveSagaRouteId, deriveTurnCommitId, normalizeSagaCorrelation } from '@redemeine/saga-runtime';
import { createCounters, createRealTable } from './fixtures';
import { sourceEvent } from './harness';

export type Expected = { sagaId: string; sagaKey: string; partition: string; eventId: string;
  sourceTriggerId: string; sourcePartition: string; sourceStream: string; sourceCommit: string;
  amount: number; sourceTime: string };

function same(actual: unknown, expected: unknown): void {
  if (!isDeepStrictEqual(actual, expected)) throw new Error('physical material differs from expected fixture');
}

function fixtureEvents(expected: Expected, commitId: string) {
  const { definition, table } = createRealTable('crash-proof', createCounters());
  same(definition.sagaKey, expected.sagaKey);
  const registration = table.registered?.[0];
  if (!registration) throw new Error('missing fixture registration');
  const source = sourceEvent(expected.eventId, 'real.order-placed.v1.event',
    { orderId: 'crash-order', amount: expected.amount });
  const payloads = [
    { id: expected.sagaId, sagaType: definition.sagaType, lifecycleState: 'active', createdAt: expected.sourceTime },
    { schemaVersion: 1, ...registration.definitionIdentity },
    { record: { eventType: source.type, sourcePosition: { partitionId: expected.sourcePartition,
      streamId: expected.sourceStream, commitId: expected.sourceCommit, eventIndex: 0 },
    eventId: expected.eventId, observedAt: expected.sourceTime, payload: source.payload,
    aggregateType: source.aggregateType, aggregateId: source.aggregateId, sequence: 0,
    correlationId: source.metadata?.correlationId, metadata: source.metadata } },
    { schemaVersion: 1, sagaKey: expected.sagaKey, definitionVersion: 1,
      correlation: normalizeSagaCorrelation('crash-order'), sourceTriggerId: expected.sourceTriggerId,
      state: { count: 0, seen: [] }, recordedAt: expected.sourceTime }
  ];
  return payloads.map((payload, index) => ({ id: `${commitId}:event:${index}`,
    type: ['saga.instance_created.event', 'saga.definition_identity_recorded.event',
      'saga.source_event_observed.event', 'saga.business_state_recorded.event'][index], version: index, payload }));
}

export function expectedMaterial(expected: Expected) {
  const routeId = deriveSagaRouteId({ kind: 'start', sagaKey: expected.sagaKey,
    definitionVersion: 1, triggerIndex: 0, eventType: 'real.order-placed.v1.event' });
  const identity = { sourceTriggerId: expected.sourceTriggerId, sagaKey: expected.sagaKey,
    instanceId: expected.sagaId, routeId };
  const id = deriveTurnCommitId(identity);
  return { id, partitionId: expected.partition, streamId: expected.sagaId,
    commitSequence: 0, sagaTurnIdentity: identity, events: fixtureEvents(expected, id), isDispatched: false };
}

export function proveMaterial(rows: readonly unknown[], expected: Expected): { physical: number; intentFacts: number;
  stateMatches: boolean; materialSha256: string } {
  if (rows.length !== 1) throw new Error('unexpected physical turn count');
  const row = rows[0];
  if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('invalid physical turn');
  const stored = row as Record<string, unknown>;
  if (!(stored._id instanceof ObjectId) || !(stored.token instanceof UUID) ||
    !(stored.createDateTime instanceof Date) || Number.isNaN(stored.createDateTime.getTime()) ||
    stored.isDispatched !== false) throw new Error('invalid physical envelope');
  const { _id: _id, token: _token, createDateTime: _created, ...deterministic } = stored;
  same(deterministic, expectedMaterial(expected));
  return { physical: rows.length, intentFacts: 0, stateMatches: true,
    materialSha256: createHash('sha256').update(BSON.EJSON.stringify(rows)).digest('hex') };
}

export function proveUnchanged(before: readonly unknown[], after: readonly unknown[]): void {
  if (BSON.EJSON.stringify(after) !== BSON.EJSON.stringify(before)) {
    throw new Error('physical material changed or extra turn appended');
  }
}
