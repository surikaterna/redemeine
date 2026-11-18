import {
  createProjection, replayProjectionChangeTransition,
  type ProjectionChangeTransition, type ProjectionJsonValue, type ProjectionSourceCommit, type ProjectionSourceCommitSnapshot,
  type ProjectionStoreCommitAtomicManyRequest
} from '@redemeine/projection-runtime-core';
import { reduceProjectionSourceCommit } from '../../projection-worker-core/src/projectionCommitReducer';

type Line = { sku: string; quantity: number };
export type Order = { lines: Line[]; shipping: { region: string; 'tax.rate'?: number } };
type Edit = 'RemoveMiddle' | 'InsertMiddle' | 'EditSecond' | 'ReplaceSecond' | 'RemoveLast' | 'Append' | 'Ship' | 'UndoShip' | 'Tax' | 'Opened';
export interface OrderCase {
  name: string;
  edits: readonly [Edit, ...Edit[]];
  expected: Order;
  writes: readonly string[];
}

const line = (sku: string, quantity = 1): Line => ({ sku, quantity });
const order = (...lines: Line[]): Order => ({ lines, shipping: { region: 'EU' } });
export const baselineOrder = order(line('a'), line('b'), line('c'));
export const orderSourceId = '00000000-0000-4000-8000-000000000001';

export const orderCases: readonly OrderCase[] = [
  { name: 'middle removal', edits: ['RemoveMiddle'], expected: order(line('a'), line('c')), writes: ['$set:state.lines'] },
  { name: 'middle insertion', edits: ['InsertMiddle'], expected: order(line('a'), line('d'), line('b'), line('c')), writes: ['$set:state.lines'] },
  { name: 'remove then edit moved line', edits: ['RemoveMiddle', 'EditSecond'],
    expected: order(line('a'), line('c', 4)), writes: ['$set:state.lines'] },
  { name: 'independent events', edits: ['EditSecond', 'Ship'],
    expected: { ...order(line('a'), line('b', 4), line('c')), shipping: { region: 'US' } },
    writes: ['$set:state.lines.1.quantity', '$set:state.shipping.region'] },
  { name: 'metadata only', edits: ['Opened', ...Array<'Opened'>(31).fill('Opened')], expected: baselineOrder, writes: [] },
  { name: 'net no-op', edits: ['Ship', 'UndoShip'], expected: baselineOrder, writes: [] },
  { name: 'literal dotted key', edits: ['Tax'],
    expected: { ...baselineOrder, shipping: { region: 'EU', 'tax.rate': 5 } }, writes: ['$set:state'] },
  { name: 'nested line edit', edits: ['EditSecond'], expected: order(line('a'), line('b', 4), line('c')),
    writes: ['$set:state.lines.1.quantity'] },
  { name: 'line replacement', edits: ['ReplaceSecond'], expected: order(line('a'), line('d'), line('c')), writes: ['$set:state.lines.1'] },
  { name: 'last line removal', edits: ['RemoveLast'], expected: order(line('a'), line('b')), writes: ['$pop:state.lines'] },
  { name: 'append line', edits: ['Append'], expected: order(line('a'), line('b'), line('c'), line('d')), writes: ['$push:state.lines'] }
];

export function stateWriteShape(update: Record<string, Record<string, unknown>>): string[] {
  return Object.entries(update).flatMap(([modifier, fields]) => Object.keys(fields)
    .filter((path) => path === 'state' || path.startsWith('state.')).map((path) => `${modifier}:${path}`)).sort();
}

export function orderSnapshotRequest(scenario: OrderCase) {
  return { projectionName: scenario.name, projectionGeneration: 'g1', targetDocumentIds: [scenario.name],
    links: [], progressStrategy: 'own_record' as const, sourceId: orderSourceId };
}

export function orderTurn(scenario: OrderCase, sequence: 0 | 1, snapshot: ProjectionSourceCommitSnapshot<Order>, recording = true) {
  const definition = createProjection(scenario.name, () => structuredClone(baselineOrder))
    .from({ aggregateType: 'Order', initialState: {}, pure: { eventProjectors: {} } }, {
      Opened() {},
      RemoveMiddle(draft) { draft.lines.splice(1, 1); },
      InsertMiddle(draft) { draft.lines.splice(1, 0, line('d')); },
      EditSecond(draft) { draft.lines[1]!.quantity = 4; },
      ReplaceSecond(draft) { draft.lines[1] = line('d'); },
      RemoveLast(draft) { draft.lines.pop(); },
      Append(draft) { draft.lines.push(line('d')); },
      Ship(draft) { draft.shipping.region = 'US'; },
      UndoShip(draft) { draft.shipping.region = 'EU'; },
      Tax(draft) { draft.shipping['tax.rate'] = 5; }
    }).identity(() => scenario.name).deduplication({ strategy: 'own_record' }).buildCommitDefinition();
  const types = sequence === 0 ? ['Opened'] : scenario.edits;
  const events = types.map((type, eventIndex) => ({
    type, eventIndex, eventId: `00000000-0000-4000-8001-${String(sequence * 10 + eventIndex).padStart(12, '0')}`,
    streamVersion: sequence + eventIndex, aggregateType: 'Order', aggregateId: 'order', payload: {},
    timestamp: '2026-09-22T00:00:00.000Z'
  })) as unknown as ProjectionSourceCommit['events'];
  const source = { streamId: orderSourceId, commitSequence: sequence, events,
    commitId: `00000000-0000-4000-8000-${String(sequence + 10).padStart(12, '0')}` };
  const reduction = reduceProjectionSourceCommit(definition, 'g1', source, snapshot, undefined, recording ? 'orders_view' : undefined);
  if (reduction.status !== 'planned') throw new Error(`Expected a plan: ${JSON.stringify(reduction)}`);
  return reduction.request;
}

export function replayOrderEdits(transitions: readonly ProjectionChangeTransition[]): ProjectionJsonValue[] {
  let state: ProjectionJsonValue = baselineOrder;
  return transitions.map((transition) => {
    const next = replayProjectionChangeTransition(state, transition);
    if (next === undefined) throw new Error('Could not replay recorded order transition');
    state = next;
    return next;
  });
}

export function legacyOrderWrite(scenario: OrderCase, documentId = scenario.name) {
  const request = orderTurn(scenario, 1, { ownRecordSequence: 0, links: [],
    targets: [{ targetDocumentId: scenario.name, state: baselineOrder, revision: 1, sourceProgress: {} }] });
  const patch = request.additionalWrites![0].targets[0]!.transitions[0]!.patch;
  return { mode: 'atomic-all' as const, writes: [{
      routingKeySource: `Order:${scenario.name}`, dedupe: { upserts: [] }, documents: [{
      mode: 'patch' as const, documentId, fullDocument: scenario.expected, patch,
      checkpoint: { sequence: 1 }, precondition: { expectedRevision: 0 }
    }]
  }] } satisfies ProjectionStoreCommitAtomicManyRequest<Order>;
}
