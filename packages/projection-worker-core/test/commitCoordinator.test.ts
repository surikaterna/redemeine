import { describe, expect, jest, test } from '@jest/globals';
import type {
  CommitProjectionSourceCommitCommitted,
  CommitProjectionSourceCommitRequest,
  CommitProjectionSourceCommitResult,
  ProjectionCommitDefinition,
  ProjectionCompleteCommitRangeReader,
  ProjectionQueueRegistryManifest,
  ProjectionSourceCommit,
  ProjectionSourceCommitSnapshot,
  ProjectionSourceCommitStorePort,
  ProjectionSourceOrderPort
} from '@redemeine/projection-runtime-core';
import {
  buildProjectionChangesReceipt, createProjection, freezePortableProjectionChangeJson, projectionUuidToBase64Url22,
  validateProjectionChangesState, verifyProjectionSourceCommitStatePatches
} from '@redemeine/projection-runtime-core';
import {
  createProjectionCommitCoordinator,
  createProjectionLaneScheduler,
  reduceProjectionSourceCommit
} from '../src';
import type { ProjectionCommitCoordinatorOptions } from '../src';
import { executeProjectionDefinition } from '../src/projectionDefinitionExecutor';
import { InMemoryProjectionStore } from '../../projection-runtime-store-inmemory/src';

const SOURCE_A = '00000000-0000-4000-8000-000000000001';
const SOURCE_B = '00000000-0000-4000-8000-000000000002';
const HASH = `sha256:${'a'.repeat(64)}` as const;

type State = { count: number; seen: string[] };

function commit(sequence: number, source = SOURCE_A, types: readonly string[] = ['Added']): ProjectionSourceCommit {
  const [first, ...rest] = types.map((type, eventIndex) => ({
    eventId: `00000000-0000-4000-8001-${String((sequence * 10) + eventIndex).padStart(12, '0')}`,
    eventIndex,
    streamVersion: (sequence * 10) + eventIndex,
    aggregateType: 'Order',
    aggregateId: source,
    type,
    payload: { amount: 1 },
    timestamp: '2026-09-22T00:00:00.000Z'
  }));
  if (!first) throw new Error('Test source commit requires at least one event.');
  return {
    streamId: source,
    commitId: `00000000-0000-4000-8000-${String(sequence + 100).padStart(12, '0')}`,
    commitSequence: sequence,
    events: [first, ...rest]
  };
}

function definition(
  name: string,
  strategy: ProjectionCommitDefinition<State>['deduplication'],
  handler?: ProjectionCommitDefinition<State>['fromStream']['handlers'][string]
): ProjectionCommitDefinition<State> {
  return {
    name,
    fromStream: {
      aggregate: { aggregateType: 'Order', initialState: {}, pure: { eventProjectors: {} } },
      handlers: {
        Added: handler ?? ((state, event) => {
          state.count += Number(event.payload.amount);
          state.seen.push(event.type);
        })
      }
    },
    initialState: () => ({ count: 0, seen: [] }),
    identity: (event) => event.aggregateId,
    subscriptions: [],
    deduplication: strategy
  };
}

describe('commit-native projection changes', () => {
  test('scopes registration to the manifest and keeps the collection stable through conflicts', async () => {
    const store = new InMemoryProjectionStore<State>();
    const reducer = definition('orders', { strategy: 'own_record' });
    const options = coordinatorOptions([reducer], store);
    const registration = { definition: reducer, generation: 'g1', projectionChanges: 'orders-view' };
    const manifestEntries = options.manifest.definitions.map((entry) => ({ ...entry, projectionChanges: 'orders-view' }));
    const config = { ...options, definitions: [registration], manifest: { ...options.manifest, definitions: manifestEntries } };
    expect(() => createProjectionCommitCoordinator({ ...options, definitions: [registration] })).toThrow(/immutable manifest/);
    expect(() => createProjectionCommitCoordinator({ ...config, definitions: [{ ...registration, projectionChanges: 'other' }] }))
      .toThrow(/immutable manifest/);
    expect(() => createProjectionCommitCoordinator({ ...config, definitions: [{ ...registration, generation: 'g2' }] })).toThrow(/scopes/);
    manifestEntries[0]!.projectionChanges = 'bad\0name';
    expect(() => createProjectionCommitCoordinator(config)).toThrow(/definitions\[0\]\.projectionChanges/);
    manifestEntries[0]!.projectionChanges = 'orders-view';

    const runtime = createProjectionCommitCoordinator(config);
    const commitSource = store.commitProjectionSourceCommit.bind(store);
    jest.spyOn(store, 'commitProjectionSourceCommit').mockImplementationOnce(async () => {
      registration.projectionChanges = 'different-view';
      return { version: 1, status: 'rejected', category: 'conflict', retryable: true, reason: 'injected' };
    }).mockImplementation(commitSource);
    expect(await runtime.process(commit(0))).toMatchObject({ status: 'completed', definitions: [{ outcome: { attempts: 2 } }] });
    expect(store.getProjectionChanges()).toEqual([expect.objectContaining({ collection: 'orders-view', projectionGeneration: 'g1' })]);
    expect(reducer).not.toHaveProperty('projectionChanges');
  });

  test('normalizes Immer paths for array edits, numeric keys and escaped member names', () => {
    const initial = { '0': 'old', 'a~/b': [1, 2, 3] };
    const definition = createProjection('orders', () => initial)
      .from({ aggregateType: 'Order', initialState: {}, pure: { eventProjectors: {} } }, {
        Added(draft) {
          draft['a~/b'].splice(1, 1, 4, 5);
          draft['0'] = 'new';
        },
        Same(draft) { draft['a~/b'] = draft['a~/b'].slice(); }
      }).deduplication({ strategy: 'own_record' }).buildCommitDefinition();
    const snapshot = { targets: [{ targetDocumentId: SOURCE_A, revision: 1, state: initial, sourceProgress: {} }],
      links: [], ownRecordSequence: null };
    const result = reduceProjectionSourceCommit(definition, 'g1', commit(0, SOURCE_A, ['Added', 'Same']), snapshot, undefined, 'order_views');
    if (result.status !== 'planned') throw new Error(`Unexpected ${result.status}`);
    const transitions = result.request.additionalWrites?.[0].targets[0]?.transitions;
    expect(transitions?.[0]?.patch).toEqual([
      { op: 'replace', path: '/a~0~1b/1', value: 4 },
      { op: 'replace', path: '/a~0~1b/2', value: 5 },
      { op: 'add', path: '/a~0~1b/3', value: 3 },
      { op: 'replace', path: '/0', value: 'new' }
    ]);
    expect(transitions?.[1]).toMatchObject({ changeType: 'update', patch: [{ op: 'replace', path: '/a~0~1b', value: [1, 4, 5, 3] }] });
    expect(validateProjectionChangesState(result.request, snapshot)).toBeNull();
  });

  test('keeps numeric Immer paths for edits to a root array', () => {
    const initial = [1, 2];
    const definition = createProjection('orders', () => initial)
      .from({ aggregateType: 'Order', initialState: {}, pure: { eventProjectors: {} } }, {
        Added(draft) { draft.unshift(0); }
      }).deduplication({ strategy: 'own_record' }).buildCommitDefinition();
    const snapshot = { targets: [{ targetDocumentId: SOURCE_A, revision: 1, state: initial, sourceProgress: {} }],
      links: [], ownRecordSequence: null };
    const result = reduceProjectionSourceCommit(definition, 'g1', commit(0), snapshot, undefined, 'order_views');
    if (result.status !== 'planned') throw new Error(`Unexpected ${result.status}`);
    expect(result.request.additionalWrites?.[0].targets[0]?.transitions[0]?.patch).toEqual([
      { op: 'replace', path: '/0', value: 0 },
      { op: 'replace', path: '/1', value: 1 },
      { op: 'add', path: '/2', value: 2 }
    ]);
    expect(validateProjectionChangesState(result.request, snapshot)).toBeNull();
  });

  test('rejects a snapshot with a nested own __proto__ even if the handler removes it', () => {
    const initial = { nested: JSON.parse('{"__proto__":1}') as Record<string, number> };
    const definition = createProjection('orders', () => initial)
      .from({ aggregateType: 'Order', initialState: {}, pure: { eventProjectors: {} } }, {
        Added(draft) { delete draft.nested.__proto__; }
      }).deduplication({ strategy: 'own_record' }).buildCommitDefinition();
    const snapshot = { targets: [{ targetDocumentId: SOURCE_A, revision: 1, state: initial, sourceProgress: {} }],
      links: [], ownRecordSequence: null };
    expect(reduceProjectionSourceCommit(definition, 'g1', commit(0), snapshot, undefined, 'order_views', { load: true }))
      .toMatchObject({ status: 'terminal', reason: expect.stringContaining('portable JSON') });
  });

  test('groups fanout by target and preserves creation defaults, hook-only changes, escaped paths and event order', () => {
    type FeedState = State & { 'a~/b': string; defaults: { ready: boolean } };
    let handlerDraft: FeedState | undefined;
    const aggregate = { aggregateType: 'Order', initialState: {}, pure: { eventProjectors: {} } };
    const builder = createProjection<FeedState>('orders', () => ({
      count: 0, seen: [], 'a~/b': 'initial', defaults: { ready: true }
    })).from(aggregate, {
      Added: (draft) => { draft.count += 1; },
      Hook: (draft) => { handlerDraft = draft; draft.seen.push('handler'); },
      NoOp: (draft) => { draft.count += 1; }
    }).identity(() => ['two', 'one', 'two']).hooks({
      afterEach: (state, event) => {
        if (event.type === 'Added') state.seen.push('created');
        if (event.type === 'NoOp') state.count -= 1;
        if (event.type !== 'Hook') return;
        expect(state).toBe(handlerDraft);
        handlerDraft = undefined;
        state['a~/b'] = 'updated';
        state.seen.push('hook');
      }
    }).deduplication({ strategy: 'own_record' });
    const source = commit(0, SOURCE_A, ['Added', 'Ignored', 'Hook', 'NoOp']);
    const result = reduceProjectionSourceCommit(builder.buildCommitDefinition(), 'g1', source, {
      ...snapshot(),
      targets: ['one', 'two'].map((targetDocumentId) =>
        ({ targetDocumentId, state: null, revision: null, sourceProgress: {} }))
    }, undefined, 'order_views');
    expect(result.status).toBe('planned');
    if (result.status !== 'planned') return;
    const append = result.request.additionalWrites?.[0];
    expect(append).toMatchObject({ kind: 'projection_changes', collection: 'order_views' });
    expect(append?.targets.map(({ targetDocumentId }) => targetDocumentId)).toEqual(['one', 'two']);
    for (const target of append?.targets ?? []) {
      expect(target.transitions).toEqual([
        { eventIndex: 0, eventId: source.events[0].eventId, changeType: 'create', patch: [{ op: 'add', path: '',
          value: { count: 1, seen: ['created'], 'a~/b': 'initial', defaults: { ready: true } } }] },
        { eventIndex: 2, eventId: source.events[2]?.eventId, changeType: 'update', patch: [
          { op: 'add', path: '/seen/1', value: 'handler' },
          { op: 'add', path: '/seen/2', value: 'hook' },
          { op: 'replace', path: '/a~0~1b', value: 'updated' }
        ] },
        { eventIndex: 3, eventId: source.events[3]?.eventId, changeType: 'noop', patch: [] }
      ]);
    }
    expect(result.request.finalDocuments.map(({ finalDocument }) => finalDocument)).toEqual(Array(2).fill(
      { count: 1, seen: ['created', 'handler', 'hook'], 'a~/b': 'updated', defaults: { ready: true } }
    ));
    expect(validateProjectionChangesState(result.request, { targets: ['one', 'two'].map((targetDocumentId) =>
      ({ targetDocumentId, state: null, revision: null, sourceProgress: {} }))
    })).toBeNull();
  });

  test.each([true, false])('a hook failure prevents all writes, recording=%s', async (recording) => {
    const hooked = {
      ...definition('orders', { strategy: 'own_record' }),
      hooks: { afterEach: (state: State) => { if (state.count === 2) throw new Error('hook rejected'); } }
    };
    const store = new InMemoryProjectionStore<State>();
    const write = jest.spyOn(store, 'commitProjectionSourceCommit');
    const result = await executeProjectionDefinition({
      definition: hooked, generation: 'g1', store, lanes: createProjectionLaneScheduler(), maxConflictRetries: 0,
      ...(recording ? { projectionChanges: 'order_views' } : {})
    }, commit(0, SOURCE_A, ['Added', 'Added']));
    expect(result).toMatchObject({ status: 'terminal', reason: 'hook rejected' });
    expect(write).not.toHaveBeenCalled();
  });

  test('rejects a promise-returning hook before persistence', () => {
    const hooked = {
      ...definition('orders', { strategy: 'own_record' }),
      hooks: { afterEach: async (state: State) => { await Promise.resolve(); state.count++; } }
    };
    const result = reduceProjectionSourceCommit(hooked, 'g1', commit(0), snapshot({
      targets: [{ targetDocumentId: SOURCE_A, state: null, revision: null, sourceProgress: {} }]
    }));
    expect(result).toEqual({ status: 'terminal', reason: 'Projection afterEach must be synchronous.' });
  });

  test('an adapter without explicit capability is rejected before it can drop an append or advance progress', async () => {
    const store = new InMemoryProjectionStore<State>();
    const commitSource = jest.fn(async (request: CommitProjectionSourceCommitRequest<State>) => {
      const { additionalWrites, ...stripped } = request;
      return store.commitProjectionSourceCommit(stripped);
    });
    const result = await executeProjectionDefinition({
      definition: definition('orders', { strategy: 'own_record' }), projectionChanges: 'order_views',
      generation: 'g1', store: {
        loadProjectionSourceCommitSnapshot: store.loadProjectionSourceCommitSnapshot.bind(store),
        commitProjectionSourceCommit: commitSource
      }, lanes: createProjectionLaneScheduler(), maxConflictRetries: 0
    }, commit(0));
    expect(result).toMatchObject({ status: 'terminal', reason: 'Store does not support atomic projection_changes turn receipts.' });
    expect(commitSource).not.toHaveBeenCalled();
  });

  const strategies = [
    { strategy: 'own_record' },
    { strategy: 'in_document' }
  ] satisfies ProjectionCommitDefinition<State>['deduplication'][];

  test.each(strategies)('$strategy verifies original receipt identity even after later turns', async (strategy) => {
    const store = new InMemoryProjectionStore<State>();
    const runtime = changeCoordinator(definition('orders', strategy), store);
    const source = commit(0);
    expect((await runtime.process(source)).status).toBe('completed');
    expect((await runtime.process(commit(1))).status).toBe('completed');
    expect(await runtime.process(source)).toMatchObject({ status: 'completed', definitions: [{ outcome: { status: 'deduplicated' } }] });
    expect(await runtime.process({ ...source, commitId: '10000000-0000-4000-8000-000000000040' })).toMatchObject({
      status: 'terminal', reason: 'projection change source commit or collection identity mismatch'
    });
    expect(store.getProjectionChanges()).toHaveLength(2);
  });

  test.each(strategies)('$strategy cannot deduplicate a second attempt after a claimed-capable adapter strips the append', async (strategy) => {
    const native = new InMemoryProjectionStore<State>();
    const store: ProjectionSourceCommitStorePort<State> = {
      projectionChangesCapability: native.projectionChangesCapability,
      loadProjectionSourceCommitSnapshot: native.loadProjectionSourceCommitSnapshot.bind(native),
      async commitProjectionSourceCommit(request) {
        const { additionalWrites, ...stripped } = request;
        return native.commitProjectionSourceCommit(stripped);
      }
    };
    const runtime = changeCoordinator(definition('orders', strategy), store);
    expect(await runtime.process(commit(0))).toMatchObject({ status: 'terminal', reason: 'Store did not return a matching projection_changes receipt.' });
    expect(await runtime.process(commit(0))).toMatchObject({ status: 'terminal', reason: expect.stringMatching(/Missing projection_changes history/) });
    expect(native.getProjectionChanges()).toEqual([]);
    expect(await native.load(SOURCE_A)).toMatchObject({ count: 1 });
  });

  test.each(strategies)('$strategy proves no-target coverage and rejects a missing receipt for covered history', async (strategy) => {
    const store = new InMemoryProjectionStore<State>();
    const runtime = changeCoordinator(definition('orders', strategy), store);
    const ignored = commit(0, SOURCE_A, ['Ignored']);
    expect((await runtime.process(ignored)).status).toBe('completed');
    expect((await runtime.process(commit(1))).status).toBe('completed');
    expect(await runtime.process(ignored)).toMatchObject({ status: 'completed', definitions: [{ outcome: { status: 'deduplicated' } }] });
    expect(await runtime.processPolled(ignored)).toMatchObject({ status: 'completed', processedSequences: [] });
    expect(store.getProjectionChanges()).toHaveLength(1);
    store.clear();
    expect(await runtime.process(ignored)).toMatchObject({ status: 'terminal', reason: expect.stringMatching(/Missing projection_changes history/) });
    expect(await runtime.processPolled(ignored)).toMatchObject({ status: 'terminal', reason: expect.stringMatching(/Missing projection_changes history/) });
    expect(store.getProjectionChanges()).toEqual([]);
  });

  test.each([
    ['fresh empty', 'empty', false, false, 'committed'],
    ['fresh target', 'record', true, false, 'committed'],
    ['fresh empty with record', 'record', false, false, 'terminal'],
    ['fresh target with empty receipt', 'empty', true, false, 'terminal'],
    ['both receipt fields', 'both', false, true, 'terminal'],
    ['empty receipt plus empty writes array', 'empty-array', false, false, 'terminal'],
    ['more than one write receipt', 'multiple', true, false, 'terminal'],
    ['record in empty receipt field', 'wrong-field', false, true, 'terminal'],
    ['canonical target replay of empty plan', 'record', false, true, 'deduplicated'],
    ['canonical empty replay of target plan', 'empty', true, true, 'deduplicated'],
    ['canonical replay with wrong commit ID', 'wrong-identity', false, true, 'terminal'],
    ['canonical record with different target set', 'wrong-target', true, true, 'deduplicated'],
    ['fresh record with unrelated target', 'wrong-target', true, undefined, 'terminal'],
    ['fresh record with null target', 'null-target', true, undefined, 'terminal'],
    ['canonical record with duplicate targets', 'duplicate-target', true, true, 'terminal'],
    ['fresh record with malformed target metadata', 'invalid-target', true, false, 'terminal'],
    ['empty receipt with target data', 'empty-with-targets', false, undefined, 'terminal'],
    ['reliable truthy string flag', 'empty', false, 'false', 'terminal'],
    ['none truthy string flag', 'record', true, 'false', 'terminal', 'none'],
    ['none truthy numeric flag', 'empty', false, 1, 'terminal', 'none'],
    ['none may not claim canonical replay', 'record', true, true, 'terminal', 'none'],
    ['none same-invocation receipt remains committed', 'record', true, false, 'committed', 'none']
  ] as const)('%s enforces the committed receipt envelope', async (_label, shape, targets, replayed, expected, strategy: 'own_record' | 'none' = 'own_record') => {
    const native = new InMemoryProjectionStore<State>();
    const store: ProjectionSourceCommitStorePort<State> = {
      projectionChangesCapability: native.projectionChangesCapability,
      loadProjectionSourceCommitSnapshot: native.loadProjectionSourceCommitSnapshot.bind(native),
      async commitProjectionSourceCommit(request) {
        const append = request.additionalWrites![0];
        const applicationId = strategy === 'none' ? SOURCE_B : undefined;
        const empty = buildProjectionChangesReceipt({ ...request, additionalWrites: [{ ...append, targets: [] }] }, applicationId);
        const [event] = request.commit.events;
        const record = buildProjectionChangesReceipt({ ...request, additionalWrites: [{ ...append, targets: [{
          targetDocumentId: SOURCE_A, transitions: [{ eventId: event.eventId, eventIndex: 0, changeType: 'noop', patch: [] }]
        }] }] }, applicationId);
        if (record?.kind !== 'projection_changes' || empty?.kind !== 'projection_changes_empty') throw new Error('Invalid test receipt');
        const target = record.targets[0]!;
        const malformedOrValid = {
          empty: { emptyChangeReceipt: empty }, record: { additionalWrites: [record] },
          both: { additionalWrites: [record], emptyChangeReceipt: empty },
          'empty-array': { additionalWrites: [], emptyChangeReceipt: empty },
          multiple: { additionalWrites: [record, record] }, 'wrong-field': { emptyChangeReceipt: record },
          'wrong-identity': { emptyChangeReceipt: { ...empty, commitId: SOURCE_B } },
          'wrong-target': { additionalWrites: [{ ...record, targets: [{ ...target, targetDocumentId: SOURCE_B }] }] },
          'null-target': { additionalWrites: [{ ...record, targets: [null] }] },
          'duplicate-target': { additionalWrites: [{ ...record, targets: [target, target] }] },
          'invalid-target': { additionalWrites: [{ ...record, targets: [{ ...target, revision: null }] }] },
          'empty-with-targets': { emptyChangeReceipt: { ...empty, targets: record.targets } }
        }[shape];
        return { version: 1, status: 'committed', replayed, commitSequence: request.commit.commitSequence,
          documentRevisions: {}, linkRevisions: {}, progress: request.progress, ...malformedOrValid } as CommitProjectionSourceCommitCommitted;
      }
    };
    const result = await executeProjectionDefinition({ definition: definition('orders', strategy === 'none'
      ? { strategy, duplicateEffects: 'acknowledged', reason: 'test' } : { strategy }),
      generation: 'g1', projectionChanges: 'order_views', store, lanes: createProjectionLaneScheduler(), maxConflictRetries: 0
    }, commit(0, SOURCE_A, [targets ? 'Added' : 'Ignored']));
    expect(result).toMatchObject({ status: expected });
    if (expected === 'terminal') {
      const invalidReplay = (replayed !== undefined && typeof replayed !== 'boolean') || (strategy === 'none' && replayed === true);
      expect(result).toMatchObject({ reason: invalidReplay ? 'Store returned an invalid commit replay flag.'
        : 'Store did not return a matching projection_changes receipt.' });
    }
  });

  test('a racing canonical empty commit can win over a prepared InMemory target plan', async () => {
    const native = new InMemoryProjectionStore<State>();
    const store: ProjectionSourceCommitStorePort<State> = {
      projectionChangesCapability: native.projectionChangesCapability,
      sourceCommitSnapshotCapability: native.sourceCommitSnapshotCapability,
      loadProjectionSourceCommitSnapshot: native.loadProjectionSourceCommitSnapshot.bind(native),
      async commitProjectionSourceCommit(request, prepared) {
        expect(request.finalDocuments).toHaveLength(1);
        expect(await native.commitProjectionSourceCommit({ ...request, finalDocuments: [], additionalWrites: [
          { ...request.additionalWrites![0], targets: [] }
        ] })).toMatchObject({ status: 'committed', emptyChangeReceipt: { kind: 'projection_changes_empty' } });
        return native.commitProjectionSourceCommit(request, prepared);
      }
    };
    expect(await executeProjectionDefinition({ definition: definition('orders', { strategy: 'own_record' }),
      generation: 'g1', projectionChanges: 'order_views', store, lanes: createProjectionLaneScheduler(), maxConflictRetries: 0
    }, commit(0))).toMatchObject({ status: 'deduplicated' });
    expect(await native.load(SOURCE_A)).toBeNull();
  });

  test('accepted reliable baseline skips do not require a durable turn receipt', async () => {
    const store = new InMemoryProjectionStore<State>();
    const runtime = changeCoordinator(
      definition('orders', { strategy: 'own_record' }), store, orderPort(), { [SOURCE_A]: 5 }
    );
    expect(await runtime.process(commit(2))).toMatchObject({ status: 'completed', definitions: [{ outcome: { status: 'deduplicated' } }] });
    expect(store.getProjectionChanges()).toEqual([]);
  });

  test.each([0, 1])('none applies direct deliveries again with anchor %d', async (anchor) => {
    const store = new InMemoryProjectionStore<State>();
    const source = commit(0);
    const reducer = definition('orders', { strategy: 'none', duplicateEffects: 'acknowledged', reason: 'test' });
    const order = orderPort();
    const runtime = changeCoordinator(reducer, store, order, { [SOURCE_A]: anchor });
    expect((await runtime.process(source)).status).toBe('completed');
    expect(await runtime.process(source)).toMatchObject({ status: 'completed', definitions: [{ outcome: { status: 'committed' } }] });
    if (anchor === 0) expect(await runtime.processPolled(source)).toMatchObject({ status: 'completed', processedSequences: [] });
    expect(order.advances).toEqual(anchor === 0 ? [0] : []);
    expect(await store.load(SOURCE_A)).toMatchObject({ count: 2 });
    expect(store.getProjectionChanges().map((entry) => entry.targets[0]?.revision)).toEqual([1, 2]);
  });

  test('none redelivery can reapply after a committed projection write and uncertain coverage', async () => {
    const store = new InMemoryProjectionStore<State>();
    const reducer = definition('orders', { strategy: 'none', duplicateEffects: 'acknowledged', reason: 'test' });
    const order = orderPort();
    const advance = order.advanceCoverage.bind(order);
    order.advanceCoverage = jest.fn<typeof advance>().mockRejectedValueOnce(new Error('coverage outcome unknown')).mockImplementation(advance);
    const runtime = changeCoordinator(reducer, store, order);
    expect((await runtime.process(commit(0))).status).toBe('retryable');
    expect((await runtime.process(commit(0))).status).toBe('completed');
    expect(await store.load(SOURCE_A)).toMatchObject({ count: 2 });
    expect(store.getProjectionChanges()).toHaveLength(2);
  });
});

function snapshot(overrides: Partial<ProjectionSourceCommitSnapshot<State>> = {}): ProjectionSourceCommitSnapshot<State> {
  return { targets: [], links: [], ownRecordSequence: null, ...overrides };
}

function manifest(names: readonly string[], anchors: Readonly<Record<string, number>> = {}): ProjectionQueueRegistryManifest {
  return {
    version: 1,
    manifestId: HASH,
    queueId: 'orders',
    registryGeneration: 'registry-1',
    identity: {
      version: 1,
      normalizedDefinitionRegistryDigest: HASH,
      normalizedRuntimeConfigurationDigest: HASH,
      executableCodeArtifactDigest: HASH
    },
    definitions: names.map((projectionName) => ({
      projectionName,
      generation: 'g1',
      definitionHash: HASH,
      sourceSelectors: ['Order']
    })),
    sourceStartAnchors: anchors
  };
}

class MemoryCommitStore implements ProjectionSourceCommitStorePort<State> {
  readonly requests: CommitProjectionSourceCommitRequest<State>[] = [];
  readonly loads: Array<{ targets: readonly string[]; strategy: string }> = [];
  readonly states = new Map<string, State>();
  readonly revisions = new Map<string, number>();
  readonly inline = new Map<string, Record<string, number>>();
  readonly own = new Map<string, number>();
  conflicts = 0;

  async loadProjectionSourceCommitSnapshot(
    request: Parameters<ProjectionSourceCommitStorePort<State>['loadProjectionSourceCommitSnapshot']>[0]
  ): Promise<ProjectionSourceCommitSnapshot<State>> {
    this.loads.push({ targets: request.targetDocumentIds, strategy: request.progressStrategy });
    return snapshot({
      targets: request.targetDocumentIds.map((targetDocumentId) => ({
        targetDocumentId,
        revision: this.revisions.get(targetDocumentId) ?? null,
        state: structuredClone(this.states.get(targetDocumentId) ?? null),
        sourceProgress: this.inline.get(targetDocumentId) ?? {}
      })),
      links: request.links.map((link) => ({ ...link, targetDocumentId: null, revision: null })),
      ownRecordSequence: request.sourceId ? this.own.get(`${request.projectionName}:${request.sourceId}`) ?? null : null
    });
  }

  async commitProjectionSourceCommit(request: CommitProjectionSourceCommitRequest<State>): Promise<CommitProjectionSourceCommitResult> {
    this.requests.push(request);
    if (this.conflicts > 0) {
      this.conflicts -= 1;
      return { version: 1 as const, status: 'rejected' as const, category: 'conflict' as const, retryable: true, reason: 'injected' };
    }
    const documentRevisions: Record<string, number> = {};
    for (const document of request.finalDocuments) {
      this.states.set(document.targetDocumentId, structuredClone(document.finalDocument));
      const revision = (document.expectedRevision ?? 0) + 1;
      this.revisions.set(document.targetDocumentId, revision);
      documentRevisions[document.targetDocumentId] = revision;
    }
    if (request.progress.strategy === 'in_document') {
      for (const target of request.progress.targets) this.inline.set(target.targetDocumentId, { ...target.final });
    }
    if (request.progress.strategy === 'own_record') {
      this.own.set(`${request.projectionName}:${request.progress.source.sourceId}`, request.progress.source.finalSequence);
    }
    return {
      version: 1 as const,
      status: 'committed' as const,
      commitSequence: request.commit.commitSequence,
      documentRevisions,
      linkRevisions: {},
      progress: request.progress
    };
  }

}

function orderPort(): ProjectionSourceOrderPort & { advances: number[] } {
  const coverage = new Map<string, number>();
  const advances: number[] = [];
  return {
    advances,
    async admitForDispatch(sourceCommit, queueBindingId, proof) {
      return {
        dispatch: true,
        boundDispatchProof: proof,
        startAnchor: 0,
        strategyScope: [],
        coverage: { queueBindingId, sourceId: sourceCommit.streamId, sequence: coverage.get(sourceCommit.streamId) ?? null }
      };
    },
    async advanceCoverage(request) {
      advances.push(request.sequence);
      coverage.set(request.sourceId, request.sequence);
      return { queueBindingId: request.queueBindingId, sourceId: request.sourceId, sequence: request.sequence };
    }
  };
}

function rangeReader(commits: readonly ProjectionSourceCommit[] = []): ProjectionCompleteCommitRangeReader {
  return {
    capability: { completeCommitBoundaries: true, unslicedCommitEvents: true },
    async readCompleteRange(request) {
      const selected = commits.filter((item) => item.streamId === request.sourceId
        && item.commitSequence > (request.afterSequence ?? -1)
        && item.commitSequence <= request.throughSequence).slice(0, request.maxCommits);
      return {
        status: 'complete',
        commits: selected.map((item) => ({ commit: item, encodedByteLength: 100 })),
        encodedByteLength: selected.length * 100,
        continuationAfterSequence: selected.at(-1)?.commitSequence ?? request.afterSequence,
        hasMore: (selected.at(-1)?.commitSequence ?? request.afterSequence ?? -1) < request.throughSequence
      };
    }
  };
}

function coordinatorOptions(
  definitions: readonly ProjectionCommitDefinition<State>[],
  store: ProjectionSourceCommitStorePort<State>,
  order = orderPort(),
  reader = rangeReader(),
  anchors: Readonly<Record<string, number>> = {}
): ProjectionCommitCoordinatorOptions<State> {
  return {
    queueBindingId: 'orders', manifest: manifest(definitions.map((item) => item.name), anchors),
    definitions: definitions.map((item) => ({ generation: 'g1', definition: item })),
    store, sourceOrder: {
      ...order,
      async admitForDispatch(sourceCommit, queueId, proof) {
        const admission = await order.admitForDispatch(sourceCommit, queueId, proof);
        return { ...admission, startAnchor: anchors[sourceCommit.streamId] ?? admission.startAnchor,
          strategyScope: definitions.map((entry) => ({ projectionName: entry.name, generation: 'g1',
            strategy: entry.deduplication.strategy, stableSingleTarget: true })) };
      }
    }, rangeReader: reader, maxCommits: 2, maxBytes: 1_000, maxConflictRetries: 2
  };
}

function coordinator(...args: Parameters<typeof coordinatorOptions>) {
  return createProjectionCommitCoordinator(coordinatorOptions(...args));
}

test('requires authoritative proof even for a recording-off scalar worker', async () => {
  const store = new InMemoryProjectionStore<State>();
  const options = coordinatorOptions([definition('boards', { strategy: 'own_record' })], store);
  const admit = options.sourceOrder.admitForDispatch.bind(options.sourceOrder);
  const advance = jest.spyOn(options.sourceOrder, 'advanceCoverage');
  const write = jest.spyOn(store, 'commitProjectionSourceCommit');
  const runtime = createProjectionCommitCoordinator({ ...options, sourceOrder: {
    ...options.sourceOrder,
    async admitForDispatch(...args) {
      const result = await admit(...args);
      return { ...result, boundDispatchProof: undefined! }; // Exercise an un-upgraded port at runtime.
    }
  } });
  expect(await runtime.process(commit(0))).toMatchObject({ status: 'terminal', reason: expect.stringContaining('missing dispatch proof') });
  expect(write).not.toHaveBeenCalled();
  expect(advance).not.toHaveBeenCalled();
});

test.each([
  { setMode: false, candidate: false },
  { setMode: false, candidate: true },
  { setMode: true, candidate: false },
  { setMode: true, candidate: true }
])('candidate maps require explicit set mode (set: $setMode, candidate B: $candidate)', async ({ setMode, candidate }) => {
  const store = new InMemoryProjectionStore<State>();
  const order = { aggregateType: 'Order' };
  const board = { aggregateType: 'Board', pure: { eventProjectors: {} } };
  const selectB = jest.fn(() => 'B');
  const selectors = candidate ? { Added: selectB } : {};
  const builder = createProjection('boards', (): State => ({ count: 0, seen: [] }))
    .from(board, { attach(draft, _event, ctx) {
      ctx.subscribeTo(order, SOURCE_A);
      draft.seen.push('attached');
    } })
    .join(order, { Added(draft) { draft.count++; } });
  if (setMode) builder.joinRight(order, selectors);
  const projection = builder.deduplication({ strategy: 'own_record' }).build();
  const options = coordinatorOptions([projection], store);
  const configured = { ...options, manifest: { ...options.manifest, definitions: [{
    ...options.manifest.definitions[0]!, joined: true as const, ...(setMode ? { joinMembership: 'set-v1' as const } : {})
  }] } };
  const seed = commit(0, SOURCE_B);
  const runtime = createProjectionCommitCoordinator(configured);
  expect(await runtime.process({ ...seed, events: [{
    ...seed.events[0], aggregateType: 'Board', aggregateId: 'A', type: 'attach'
  }] })).toMatchObject({ status: 'completed' });
  const membership = await store.loadProjectionSourceCommitSnapshot({
    projectionName: 'boards', projectionGeneration: 'g1', targetDocumentIds: [],
    links: [{ aggregateType: 'Order', aggregateId: SOURCE_A }], progressStrategy: 'none',
    ...(setMode ? { joinMembership: 'set-v1' } : {})
  });

  if (!setMode) {
    expect(membership.links[0]?.targetDocumentId).toBe('A');
    const malformed = { ...projection, joinStreams: [{ ...projection.joinStreams![0]!, candidateSelectors: selectors }] };
    expect(() => createProjectionCommitCoordinator({ ...configured, definitions: [{ generation: 'g1', definition: malformed }] }))
      .toThrow(/Candidate selectors require joinMembership: set-v1/);
    expect(selectB).not.toHaveBeenCalled();
    expect(await store.load('A')).toEqual({ count: 0, seen: ['attached'] });
    expect(await store.load('B')).toBeNull();
    return;
  }

  expect(membership.joinMemberships?.[0]?.targetDocumentIds).toEqual(['A']);
  expect(await runtime.process(commit(0))).toMatchObject({ status: 'completed' });
  expect(await store.load('A')).toEqual({ count: 1, seen: ['attached'] });
  expect(await store.load('B')).toEqual(candidate ? { count: 1, seen: [] } : null);
});

function changeCoordinator(
  definition: ProjectionCommitDefinition<State>,
  store: ProjectionSourceCommitStorePort<State>,
  order = orderPort(),
  anchors: Readonly<Record<string, number>> = {}
) {
  const options = coordinatorOptions([definition], store, order, rangeReader(), anchors);
  return createProjectionCommitCoordinator({
    ...options,
    definitions: options.definitions.map((entry) => ({ ...entry, projectionChanges: 'order_views' })),
    manifest: { ...options.manifest,
      definitions: options.manifest.definitions.map((entry) => ({ ...entry, projectionChanges: 'order_views' })) }
  });
}

describe('complete projection commit reducer', () => {
  test('folds events forward once and writes each target once', () => {
    const result = reduceProjectionSourceCommit(
      definition('counts', { strategy: 'none', duplicateEffects: 'acknowledged', reason: 'test' }),
      'g1',
      commit(0, SOURCE_A, ['Added', 'Added', 'Added']),
      snapshot({ targets: [{ targetDocumentId: SOURCE_A, revision: 4, state: { count: 2, seen: [] }, sourceProgress: {} }] })
    );
    expect(result.status).toBe('planned');
    if (result.status !== 'planned') return;
    expect(result.request.finalDocuments).toMatchObject([{
      targetDocumentId: SOURCE_A, expectedRevision: 4, finalDocument: { count: 5, seen: ['Added', 'Added', 'Added'] }
    }]);
    expect(result.request.finalDocuments[0]?.statePatch).toMatchObject({ kind: 'ordered', transitions: [
      { eventIndex: 0, changeType: 'update' }, { eventIndex: 1, changeType: 'update' }, { eventIndex: 2, changeType: 'update' }
    ] });
    expect(result.request.additionalWrites).toBeUndefined();
  });

  test('disabled recording preserves nonportable draft state without rerunning the handler', () => {
    const stamp = new Date('2026-11-18T00:00:00Z');
    let calls = 0;
    const custom = createProjection('dated', () => ({ count: 0, stamp: null as Date | null }))
      .from({ aggregateType: 'Order', initialState: {}, pure: { eventProjectors: {} } }, {
        Added(draft) { calls++; draft.count++; }
      }).identity(() => SOURCE_A).hooks({ afterEach(state) { if (state.count === 2) state.stamp = stamp; } })
      .deduplication({ strategy: 'own_record' }).buildCommitDefinition();
    const result = reduceProjectionSourceCommit(custom, 'g1', commit(0, SOURCE_A, ['Added', 'Added']), {
      targets: [{ targetDocumentId: SOURCE_A, revision: 1, state: { count: 0, stamp: null }, sourceProgress: {} }],
      links: [], ownRecordSequence: null
    });
    expect(result).toMatchObject({ status: 'planned', request: { finalDocuments: [{
      finalDocument: { count: 2, stamp }, statePatch: { kind: 'full', reason: 'nonportable-state' }
    }] } });
    expect(calls).toBe(2);
  });

  test.each(['Map', 'Set'])('a hook cannot mutate a %s in the draft even with recording off', async (kind) => {
    const initial = { counters: new Map([['orders', 3]]), tags: new Set(['before']) };
    const hook = jest.fn((draft: typeof initial) => {
      if (kind === 'Map') draft.counters.set('orders', 4);
      else draft.tags.add('after');
    });
    const hooked = createProjection('collections', () => initial)
      .from({ aggregateType: 'Order', initialState: {}, pure: { eventProjectors: {} } }, { Added() {} })
      .identity(() => SOURCE_A).hooks({ afterEach: hook }).deduplication({ strategy: 'own_record' }).buildCommitDefinition();
    const store = new InMemoryProjectionStore<typeof initial>();
    const write = jest.spyOn(store, 'commitProjectionSourceCommit');
    const result = await executeProjectionDefinition({
      definition: hooked, generation: 'g1', store, lanes: createProjectionLaneScheduler(), maxConflictRetries: 0
    }, commit(0));
    expect(hook).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ status: 'terminal', reason: expect.stringContaining('MapSet') });
    expect(write).not.toHaveBeenCalled();
    expect(await store.load(SOURCE_A)).toBeNull();
    expect(initial).toEqual({ counters: new Map([['orders', 3]]), tags: new Set(['before']) });
  });

  test.each(['Map', 'Set'])('a newly assigned %s is not a collection draft and cannot be recorded', (kind) => {
    const initial = { items: null as Map<string, number> | Set<string> | null };
    const hooked = createProjection('collections', () => initial)
      .from({ aggregateType: 'Order', initialState: {}, pure: { eventProjectors: {} } }, {
        Added(draft) { draft.items = kind === 'Map' ? new Map() : new Set(); }
      }).identity(() => SOURCE_A).hooks({ afterEach(draft) {
        if (draft.items instanceof Map) draft.items.set('orders', 4);
        else draft.items?.add('orders');
      } }).deduplication({ strategy: 'own_record' }).buildCommitDefinition();
    const before = { targets: [{ targetDocumentId: SOURCE_A, revision: 1, state: initial, sourceProgress: {} }],
      links: [], ownRecordSequence: null };
    expect(reduceProjectionSourceCommit(hooked, 'g1', commit(0), before, undefined, 'views'))
      .toMatchObject({ status: 'terminal', reason: expect.stringContaining('portable JSON') });
    const disabled = reduceProjectionSourceCommit(hooked, 'g1', commit(0), before);
    expect(disabled).toMatchObject({ status: 'planned', request: { finalDocuments: [{
      finalDocument: { items: kind === 'Map' ? new Map([['orders', 4]]) : new Set(['orders']) },
      statePatch: { kind: 'full', reason: 'nonportable-state' }
    }] } });
  });

  test.each([true, false])('a timestamp hook shares untouched lines with the frozen snapshot, recording=%s', (recording) => {
    const initial = { count: 0, lastUpdated: '', lines: Array.from({ length: 1_000 }, (_, id) => ({ id })) };
    expect(freezePortableProjectionChangeJson(initial)).toBe(true);
    const order = createProjection('orders', () => initial)
      .from({ aggregateType: 'Order', initialState: {}, pure: { eventProjectors: {} } }, {
        Added(draft) { draft.count++; }
      }).identity(() => SOURCE_A).hooks({ afterEach(draft, event) { draft.lastUpdated = event.timestamp; } })
      .deduplication({ strategy: 'own_record' }).buildCommitDefinition();
    const source = commit(0, SOURCE_A, Array<string>(32).fill('Added'));
    const from = { targets: [{ targetDocumentId: SOURCE_A, revision: 1, state: initial, sourceProgress: {} }],
      links: [], ownRecordSequence: null };
    const result = reduceProjectionSourceCommit(order, 'g1', source, from, undefined, recording ? 'order_views' : undefined);
    if (result.status !== 'planned') throw new Error('Expected a plan');
    const document = result.request.finalDocuments[0]!;
    expect(document.finalDocument.lines).toBe(initial.lines);
    expect(document.finalDocument).toMatchObject({ count: 32, lastUpdated: source.events[0].timestamp });
    expect(initial).toMatchObject({ count: 0, lastUpdated: '' });
    expect(document.statePatch).toMatchObject({ kind: 'ordered', transitions: [
      { patch: [{ op: 'replace', path: '/count', value: 1 },
        { op: 'replace', path: '/lastUpdated', value: source.events[0].timestamp }] },
      ...Array.from({ length: 31 }, (_, i) => ({ patch: [{ op: 'replace', path: '/count', value: i + 2 }] }))
    ] });
    expect(Boolean(result.request.additionalWrites)).toBe(recording);
    expect(verifyProjectionSourceCommitStatePatches(result.request, from).get(SOURCE_A)?.unchanged).toBe(false);
    expect(validateProjectionChangesState(result.request, from)).toBeNull();
  });

  test('default Immer capture does not run root portability scans', () => {
    const initial = { scanProbe: true, count: 0, lines: Array.from({ length: 32 }, (_, id) => ({ id })) };
    const custom = createProjection('scans', () => initial)
      .from({ aggregateType: 'Order', initialState: {}, pure: { eventProjectors: {} } }, {
        Noop() {}, Added(draft) { draft.count++; }
      }).identity(() => SOURCE_A).hooks({ afterEach(draft) { void draft.count; } })
      .deduplication({ strategy: 'own_record' }).buildCommitDefinition();
    const run = (count: number) => {
      const noops = Array<string>(count).fill('Noop');
      const entries = jest.spyOn(Object, 'entries');
      try {
        const result = reduceProjectionSourceCommit(custom, 'g1', commit(0, SOURCE_A, [...noops, 'Added', ...noops]), {
          targets: [{ targetDocumentId: SOURCE_A, revision: 1, state: initial, sourceProgress: {} }],
          links: [], ownRecordSequence: null
        });
        return { result, scans: entries.mock.calls.filter(([value]) => Object.hasOwn(value, 'scanProbe')).length };
      } finally {
        entries.mockRestore();
      }
    };
    const short = run(1);
    const long = run(32);
    expect(short.scans).toBe(0);
    expect(long.scans).toBe(0);
    expect(long.result).toMatchObject({ status: 'planned', request: { finalDocuments: [{
      finalDocument: { ...initial, count: 1 }, statePatch: { kind: 'ordered' }
    }] } });
    if (long.result.status !== 'planned') throw new Error('Expected a plan');
    const hint = long.result.request.finalDocuments[0]?.statePatch;
    if (hint?.kind !== 'ordered') throw new Error('Missing ordered hint');
    expect(hint.transitions.filter(({ changeType }) => changeType !== 'noop'))
      .toMatchObject([{ eventIndex: 32, changeType: 'update', patch: [{ op: 'replace', path: '/count', value: 1 }] }]);
  });

  test.each([true, false])('direct +0 to -0 assignment retains +0 and verifies as a noop, recording=%s', (recording) => {
    const custom = createProjection('signed', () => ({ count: 0 }))
      .from({ aggregateType: 'Order', initialState: {}, pure: { eventProjectors: {} } }, { Added() {} })
      .identity(() => SOURCE_A).hooks({ afterEach(draft) { draft.count = -0; } })
      .deduplication({ strategy: 'own_record' }).buildCommitDefinition();
    const before = { targets: [{ targetDocumentId: SOURCE_A, revision: 1, state: { count: 0 }, sourceProgress: {} }],
      links: [], ownRecordSequence: null };
    const result = reduceProjectionSourceCommit(custom, 'g1', commit(0), before, undefined, recording ? 'order_views' : undefined);
    if (result.status !== 'planned') throw new Error(`Expected a plan, got ${result.status}`);
    const [document] = result.request.finalDocuments;
    expect(Object.is(document?.finalDocument.count, +0)).toBe(true);
    expect(document?.statePatch).toMatchObject({ kind: 'ordered', transitions: [{ changeType: 'noop', patch: [] }] });
    expect(verifyProjectionSourceCommitStatePatches(result.request, before).get(SOURCE_A)?.unchanged).toBe(true);
    expect(Boolean(result.request.additionalWrites)).toBe(recording);
    expect(validateProjectionChangesState(result.request, before)).toBeNull();
  });

  test('disabled recording keeps an actual signed-zero result authoritative even with an empty capture', () => {
    const custom = createProjection('signed', () => ({ count: 0 }))
      .from({ aggregateType: 'Order', initialState: {}, pure: { eventProjectors: {} } }, {
        Added(draft) { draft.count = 1; }
      })
      .identity(() => SOURCE_A).hooks({ afterEach(state) { state.count = -0; } })
      .deduplication({ strategy: 'own_record' }).buildCommitDefinition();
    const result = reduceProjectionSourceCommit(custom, 'g1', commit(0), {
      targets: [{ targetDocumentId: SOURCE_A, revision: 1, state: { count: 0 }, sourceProgress: {} }],
      links: [], ownRecordSequence: null
    });
    expect(result).toMatchObject({ status: 'planned', request: { finalDocuments: [{
      finalDocument: { count: -0 }, statePatch: { kind: 'ordered', transitions: [{ changeType: 'noop', patch: [] }] }
    }] } });
  });

  test.each([undefined, 'order_views'])('strict checks catch a finalized nonportable intermediate even when the final state is portable (%s)', (feed) => {
    const custom = createProjection('signed', () => ({ count: 0 }))
      .from({ aggregateType: 'Order', initialState: {}, pure: { eventProjectors: {} } }, {
        Added(draft) { draft.count = 1; },
        Changed(draft) { draft.count = 2; }
      })
      .identity(() => SOURCE_A).hooks({ afterEach(draft, event) { if (event.type === 'Added') draft.count = -0; } })
      .deduplication({ strategy: 'own_record' }).buildCommitDefinition();
    const before = { targets: [{ targetDocumentId: SOURCE_A, revision: 1, state: { count: 0 }, sourceProgress: {} }],
      links: [], ownRecordSequence: null };
    const source = commit(0, SOURCE_A, ['Added', 'Changed']);
    expect(reduceProjectionSourceCommit(custom, 'g1', source, before, undefined, feed)).toMatchObject({
      status: 'planned', request: { finalDocuments: [{ finalDocument: { count: 2 } }] }
    });
    expect(reduceProjectionSourceCommit(custom, 'g1', source, before, undefined, feed, { changes: true }))
      .toMatchObject({ status: 'terminal', reason: expect.stringContaining('portable JSON') });
  });

  test('runs handlers with Immer draft semantics without mutating loaded state', () => {
    const loaded: State = { count: 2, seen: [] };
    Object.freeze(loaded.seen);
    Object.freeze(loaded);
    const result = reduceProjectionSourceCommit(
      definition('drafts', { strategy: 'none', duplicateEffects: 'acknowledged', reason: 'test' }),
      'g1', commit(0),
      snapshot({ targets: [{ targetDocumentId: SOURCE_A, revision: 1, state: loaded, sourceProgress: {} }] })
    );
    expect(loaded).toEqual({ count: 2, seen: [] });
    expect(result.status === 'planned' && result.request.finalDocuments[0]?.finalDocument).toEqual({
      count: 3,
      seen: ['Added']
    });
    expect(result.status === 'planned' && Object.isFrozen(result.request.finalDocuments[0]?.finalDocument)).toBe(true);
  });

  test('fans out deterministically and leaves in-document progress empty for no-target commits', () => {
    const fanout = definition('fanout', { strategy: 'in_document' });
    fanout.identity = () => ['B', 'A', 'B'];
    const result = reduceProjectionSourceCommit(fanout, 'g1', commit(0), snapshot({
      targets: [
        { targetDocumentId: 'A', revision: null, state: null, sourceProgress: {} },
        { targetDocumentId: 'B', revision: null, state: null, sourceProgress: {} }
      ]
    }));
    expect(result.status === 'planned' && result.request.finalDocuments.map((item) => item.targetDocumentId)).toEqual(['A', 'B']);

    const noTarget = definition('no-target', { strategy: 'in_document' });
    noTarget.identity = () => [];
    const empty = reduceProjectionSourceCommit(noTarget, 'g1', commit(0), snapshot());
    expect(empty.status === 'planned' && empty.request).toMatchObject({ finalDocuments: [], progress: { strategy: 'in_document', targets: [] } });
  });

  test('makes earlier staged link changes visible without revisiting later or earlier events', () => {
    const joined = definition('joined', { strategy: 'none', duplicateEffects: 'acknowledged', reason: 'test' });
    joined.fromStream.aggregate.aggregateType = 'Account';
    joined.fromStream.handlers = {};
    joined.joinStreams = [{
      aggregate: { aggregateType: 'Order' },
      handlers: {
        Detach: (state, event, context) => context.unsubscribeFrom({ aggregateType: 'Order' }, event.aggregateId),
        Added: (state) => { state.count += 1; }
      }
    }];
    const result = reduceProjectionSourceCommit(joined, 'g1', commit(0, SOURCE_A, ['Detach', 'Added']), snapshot({
      targets: [{ targetDocumentId: 'target', revision: 2, state: { count: 0, seen: [] }, sourceProgress: {} }],
      links: [{ aggregateType: 'Order', aggregateId: SOURCE_A, targetDocumentId: 'target', revision: 7 }]
    }));
    expect(result.status === 'planned' && result.request).toMatchObject({
      finalDocuments: [{ targetDocumentId: 'target', finalDocument: { count: 0, seen: [] } }],
      stagedLinks: [{ operation: 'unsubscribe', targetDocumentId: 'target', expectedRevision: 7 }]
    });
  });

  test('does not stage an implicit subscription for a joined no-op handler', () => {
    const joined = definition('joined-no-op', { strategy: 'none', duplicateEffects: 'acknowledged', reason: 'test' });
    joined.fromStream.aggregate.aggregateType = 'Account';
    joined.fromStream.handlers = {};
    joined.joinStreams = [{ aggregate: { aggregateType: 'Order' }, handlers: { Added: () => undefined } }];
    const result = reduceProjectionSourceCommit(joined, 'g1', commit(0), snapshot({
      targets: [{ targetDocumentId: 'target', revision: 2, state: { count: 0, seen: [] }, sourceProgress: {} }],
      links: [{ aggregateType: 'Order', aggregateId: SOURCE_A, targetDocumentId: 'target', revision: 7 }]
    }));
    expect(result.status === 'planned' && result.request.stagedLinks).toEqual([]);
  });

  test('stages only an explicit joined subscribe request', () => {
    const joined = definition('joined-subscribe', { strategy: 'none', duplicateEffects: 'acknowledged', reason: 'test' });
    joined.fromStream.aggregate.aggregateType = 'Account';
    joined.fromStream.handlers = {};
    joined.joinStreams = [{
      aggregate: { aggregateType: 'Order' },
      handlers: { Added: (state, event, context) => context.subscribeTo({ aggregateType: 'Order' }, event.aggregateId) }
    }];
    const result = reduceProjectionSourceCommit(joined, 'g1', commit(0), snapshot({
      targets: [{ targetDocumentId: 'target', revision: 2, state: { count: 0, seen: [] }, sourceProgress: {} }],
      links: [{ aggregateType: 'Order', aggregateId: SOURCE_A, targetDocumentId: 'target', revision: 7 }]
    }));
    expect(result.status === 'planned' && result.request.stagedLinks).toEqual([{
      operation: 'subscribe', aggregateType: 'Order', aggregateId: SOURCE_A,
      targetDocumentId: 'target', expectedRevision: 7
    }]);
  });

  test('applies exact own-record, in-document and none sequence-only semantics', async () => {
    const ownStore = new MemoryCommitStore();
    ownStore.own.set(`own:${SOURCE_A}`, 5);
    await coordinator([definition('own', { strategy: 'own_record' })], ownStore).process(commit(5));
    expect(ownStore.requests).toHaveLength(0);

    const inlineStore = new MemoryCommitStore();
    inlineStore.inline.set(SOURCE_A, { [projectionUuidToBase64Url22(SOURCE_A)]: 3 });
    await coordinator([definition('inline', { strategy: 'in_document' })], inlineStore).process(commit(3));
    expect(inlineStore.requests).toHaveLength(0);

    const noneStore = new MemoryCommitStore();
    const runtime = coordinator([
      definition('none', { strategy: 'none', duplicateEffects: 'acknowledged', reason: 'test' })
    ], noneStore);
    await runtime.process(commit(0));
    await runtime.process(commit(0));
    expect(noneStore.requests).toHaveLength(2);
    expect(noneStore.requests.every((request) => request.progress.strategy === 'none')).toBe(true);
  });

  test('records own progress without targets and suppresses inline targets independently', async () => {
    const ownStore = new MemoryCommitStore();
    const noTarget = definition('own-empty', { strategy: 'own_record' });
    noTarget.identity = () => [];
    await coordinator([noTarget], ownStore).process(commit(0));
    expect(ownStore.requests[0]).toMatchObject({
      finalDocuments: [],
      progress: { strategy: 'own_record', source: { expectedSequence: null, finalSequence: 0 } }
    });

    const inlineStore = new MemoryCommitStore();
    inlineStore.states.set('A', { count: 9, seen: [] });
    inlineStore.inline.set('A', { [projectionUuidToBase64Url22(SOURCE_A)]: 2 });
    const mixed = definition('inline-mixed', { strategy: 'in_document' });
    mixed.identity = () => ['A', 'B'];
    await coordinator([mixed], inlineStore, orderPort(), rangeReader(), { [SOURCE_A]: 2 }).process(commit(2));
    expect(inlineStore.requests[0]?.finalDocuments.map((item) => item.targetDocumentId)).toEqual(['B']);
    expect(inlineStore.requests[0]?.progress).toMatchObject({
      strategy: 'in_document',
      targets: [{ targetDocumentId: 'B' }]
    });
  });

  test('reloads and reruns pure handlers after a bounded OCC conflict', async () => {
    const store = new MemoryCommitStore();
    store.conflicts = 1;
    const calls: number[] = [];
    const runtime = coordinator([definition('retry', { strategy: 'own_record' }, (state) => {
      calls.push(state.count);
      state.count += 1;
    })], store);
    const result = await runtime.process(commit(0));
    expect(result.status).toBe('completed');
    expect(calls).toEqual([0, 0]);
    expect(store.loads.filter((load) => load.targets.length === 1)).toHaveLength(2);
  });

  test('handler failure creates no store commit plan', async () => {
    const store = new MemoryCommitStore();
    const runtime = coordinator([definition('throws', { strategy: 'own_record' }, () => {
      throw new Error('pure handler failed');
    })], store);
    const result = await runtime.process(commit(0));
    expect(result).toMatchObject({ status: 'terminal', reason: 'pure handler failed' });
    expect(store.requests).toHaveLength(0);
  });
});

describe('source ordering and scheduling', () => {
  test.each([{ b: -1, first: 0 }, { b: 0, first: 1 }, { b: 4, first: 5 }])(
    'accepted B=$b begins at $first without replaying old commits', async ({ b, first }) => {
      const own = new MemoryCommitStore();
      const inline = new MemoryCommitStore();
      const none = new MemoryCommitStore();
      const anchors = { [SOURCE_A]: first };
      const ownRuntime = coordinator([definition('own', { strategy: 'own_record' })], own, orderPort(), rangeReader(), anchors);
      const inlineRuntime = coordinator([definition('inline', { strategy: 'in_document' })], inline, orderPort(), rangeReader(), anchors);
      const noneRuntime = coordinator([definition('none', { strategy: 'none', duplicateEffects: 'acknowledged', reason: 'test' })],
        none, orderPort(), rangeReader(), anchors);
      if (b >= 0) {
        expect((await ownRuntime.process(commit(b))).status).toBe('completed');
        expect((await inlineRuntime.process(commit(b))).status).toBe('completed');
        expect((await noneRuntime.process(commit(b))).status).toBe('completed');
      }
      expect(own.requests).toHaveLength(0);
      expect(inline.requests).toHaveLength(0);
      expect(none.requests).toHaveLength(b >= 0 ? 1 : 0);
      expect((await ownRuntime.process(commit(first))).status).toBe('completed');
      expect((await inlineRuntime.process(commit(first))).status).toBe('completed');
      expect((await noneRuntime.process(commit(first))).status).toBe('completed');
      expect(own.requests[0]?.progress).toMatchObject({ strategy: 'own_record', source: { expectedSequence: null,
        baselineSequence: b, finalSequence: first } });
      expect(inline.requests[0]?.progress.strategy).toBe('in_document');
      await ownRuntime.process(commit(first));
      await inlineRuntime.process(commit(first));
      await noneRuntime.process(commit(first));
      expect(own.requests).toHaveLength(1);
      expect(inline.requests).toHaveLength(1);
      expect(none.requests).toHaveLength(b >= 0 ? 3 : 2);
    }
  );

  test.each([
    { omitProof: true, diagnostic: /missing dispatch proof/ },
    { omitProof: false, diagnostic: /source start anchor/ }
  ])('invalid admission (missing proof: $omitProof) rejects before loading views', async ({ omitProof, diagnostic }) => {
    const store = new MemoryCommitStore();
    const missing = orderPort();
    missing.admitForDispatch = async (sourceCommit, queueBindingId, proof) => ({ dispatch: true,
      boundDispatchProof: omitProof ? undefined! : proof, // Deliberately exercise an invalid adapter at runtime.
      coverage: { queueBindingId, sourceId: sourceCommit.streamId, sequence: null },
      startAnchor: Number.NaN, strategyScope: [{ projectionName: 'own', generation: 'g1', strategy: 'own_record', stableSingleTarget: false }] });
    const runtime = coordinator([definition('own', { strategy: 'own_record' })], store, missing);
    expect(await runtime.process(commit(0))).toMatchObject({ status: 'terminal', reason: expect.stringMatching(diagnostic) });
    expect(store.loads).toHaveLength(0);
  });

  test('rejects obsolete process arguments before admission; polled coverage never repeats none', async () => {
    const store = new MemoryCommitStore();
    const runtime = coordinator([definition('none', { strategy: 'none', duplicateEffects: 'acknowledged', reason: 'poll' })], store);
    const call = runtime.process as (...args: unknown[]) => ReturnType<typeof runtime.process>;
    expect(await call(commit(0), { legacyReceipt: true })).toMatchObject({ status: 'terminal', reason: 'Unsupported coordinator process arguments.' });
    expect(store.requests).toHaveLength(0);
    expect((await runtime.processPolled(commit(0))).status).toBe('completed');
    expect((await runtime.processPolled(commit(0))).processedSequences).toEqual([]);
    expect(store.requests).toHaveLength(1);
    expect((await runtime.process(commit(0))).status).toBe('completed');
    expect(store.requests).toHaveLength(2);
  });

  test('untagged order wrapper cannot opt into obsolete replay admission', async () => {
    const order = { ...orderPort() };
    const store = new MemoryCommitStore();
    const sourceCommit = commit(0);
    const options = { queueBindingId: 'orders', manifest: manifest(['own']),
      definitions: [{ generation: 'g1', definition: definition('own', { strategy: 'own_record' }) }],
      store, sourceOrder: order, rangeReader: rangeReader(), maxCommits: 2, maxBytes: 1000 };
    // @ts-expect-error Simulate a caller still supplying the obsolete option.
    const runtime = createProjectionCommitCoordinator({ ...options, migrationReplay: true });
    const call = runtime.process as (...args: unknown[]) => ReturnType<typeof runtime.process>;
    expect(await call(sourceCommit, { legacyReceipt: true })).toMatchObject({ status: 'terminal' });
    expect(store.requests).toHaveLength(0);
  });

  test('own-record no-target first turn persists the post-baseline sequence', async () => {
    const store = new MemoryCommitStore();
    const noTarget = definition('own', { strategy: 'own_record' });
    noTarget.identity = () => [];
    const runtime = coordinator([noTarget], store, orderPort(), rangeReader(), { [SOURCE_A]: 8 });
    expect((await runtime.process(commit(8))).status).toBe('completed');
    expect(store.requests[0]).toMatchObject({ finalDocuments: [],
      progress: { strategy: 'own_record', source: { expectedSequence: null, baselineSequence: 7, finalSequence: 8 } } });
  });

  test('accepted in-document scope rejects fanout before a projection write', async () => {
    const store = new MemoryCommitStore();
    const fanout = definition('inline', { strategy: 'in_document' });
    fanout.identity = () => ['A', 'B'];
    const runtime = coordinator([fanout], store);
    expect((await runtime.process(commit(0))).status).toBe('terminal');
    expect(store.requests).toHaveLength(0);
  });

  test('recovers bounded gaps ascending and dispatches covered redeliveries', async () => {
    const store = new MemoryCommitStore();
    const order = orderPort();
    const runtime = coordinator([
      definition('none', { strategy: 'none', duplicateEffects: 'acknowledged', reason: 'replay' })
    ], store, order, rangeReader([commit(1), commit(2)]), { [SOURCE_A]: 1 });
    const first = await runtime.process(commit(3));
    const redelivery = await runtime.process(commit(2));
    expect(first).toMatchObject({ status: 'completed', processedSequences: [1, 2, 3] });
    expect(redelivery).toMatchObject({ status: 'completed', processedSequences: [2] });
    expect(store.requests.map((request) => request.commit.commitSequence)).toEqual([1, 2, 3, 2]);
    expect(order.advances).toEqual([1, 2, 3]);
  });

  test('keeps ordering local to each source including nonzero first anchors', async () => {
    const store = new MemoryCommitStore();
    const order = orderPort();
    const runtime = coordinator([definition('own', { strategy: 'own_record' })], store, order, rangeReader([commit(2, SOURCE_A)]), {
      [SOURCE_A]: 1,
      [SOURCE_B]: 2
    });
    await Promise.all([runtime.process(commit(1, SOURCE_A)), runtime.process(commit(2, SOURCE_B))]);
    await runtime.process(commit(3, SOURCE_A));
    const first57 = coordinator([definition('other', { strategy: 'own_record' })], new MemoryCommitStore(), orderPort(), rangeReader(), {
      [SOURCE_A]: 57
    });
    expect((await first57.process(commit(57))).status).toBe('completed');
    const bySource = store.requests.map((request) => [request.commit.streamId, request.commit.commitSequence]);
    expect(bySource.filter(([source]) => source === SOURCE_A)).toEqual([[SOURCE_A, 1], [SOURCE_A, 2], [SOURCE_A, 3]]);
    expect(bySource.filter(([source]) => source === SOURCE_B)).toEqual([[SOURCE_B, 2]]);
  });

  test('fails safe for missing history and preserves the full registry after partial failure', async () => {
    const missing = coordinator([definition('p', { strategy: 'own_record' })], new MemoryCommitStore());
    expect((await missing.process(commit(2))).status).toBe('retryable');

    const store = new MemoryCommitStore();
    const baseCommit = store.commitProjectionSourceCommit.bind(store);
    let failQ = true;
    let qAttempts = 0;
    store.commitProjectionSourceCommit = async (request) => {
      if (request.projectionName === 'q') qAttempts += 1;
      if (request.projectionName === 'q' && failQ) {
        failQ = false;
        return { version: 1, status: 'rejected', category: 'transient', retryable: true, reason: 'q unavailable' };
      }
      return baseCommit(request);
    };
    const runtime = coordinator([
      definition('p', { strategy: 'own_record' }),
      definition('n', { strategy: 'none', duplicateEffects: 'acknowledged', reason: 'replay' }),
      definition('q', { strategy: 'own_record' })
    ], store);
    expect((await runtime.process(commit(0))).status).toBe('retryable');
    expect((await runtime.process(commit(0))).status).toBe('completed');
    expect(store.requests.filter((request) => request.projectionName === 'p')).toHaveLength(1);
    expect(store.requests.filter((request) => request.projectionName === 'n')).toHaveLength(2);
    expect(qAttempts).toBe(2);
  });

  test.each(['sliced_boundary', 'history_unavailable'] as const)(
    'fails safe when gap history reports %s',
    async (reason) => {
      const reader: ProjectionCompleteCommitRangeReader = {
        capability: { completeCommitBoundaries: true, unslicedCommitEvents: true },
        async readCompleteRange(request) {
          return { status: 'incomplete', reason, details: 'not foldable', continuationAfterSequence: request.afterSequence };
        }
      };
      const runtime = coordinator([definition('p', { strategy: 'own_record' })], new MemoryCommitStore(), orderPort(), reader);
      expect(await runtime.process(commit(2))).toMatchObject({ status: 'retryable', processedSequences: [] });
    }
  );

  test('rejects reduced runtime registries before processing', () => {
    const base = definition('p', { strategy: 'own_record' });
    expect(() => createProjectionCommitCoordinator({
      queueBindingId: 'orders',
      manifest: manifest(['p', 'missing']),
      definitions: [{ generation: 'g1', definition: base }],
      store: new MemoryCommitStore(),
      sourceOrder: orderPort(),
      rangeReader: rangeReader(),
      maxCommits: 2,
      maxBytes: 1_000
    })).toThrow('exactly match');
  });

  test('locks all sorted target lanes while independent lanes overlap', async () => {
    const lanes = createProjectionLaneScheduler();
    const events: string[] = [];
    let release!: () => void;
    let started!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const didStart = new Promise<void>((resolve) => { started = resolve; });
    const first = lanes.run(['B', 'A'], async () => {
      events.push('start:AB');
      started();
      await blocked;
      events.push('end:AB');
    });
    const overlap = lanes.run(['B'], async () => { events.push('run:B'); });
    const independent = lanes.run(['C'], async () => { events.push('run:C'); });
    await didStart;
    await independent;
    expect(events).toEqual(['start:AB', 'run:C']);
    release();
    await Promise.all([first, overlap]);
    expect(events).toEqual(['start:AB', 'run:C', 'end:AB', 'run:B']);
  });

  test('legacy worker also excludes overlapping multi-target turns', async () => {
    const { createProjectionWorkerCore } = await import('../src');
    const events: string[] = [];
    let release!: () => void;
    let started!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const didStart = new Promise<void>((resolve) => { started = resolve; });
    const worker = createProjectionWorkerCore(async ({ commit: item }) => {
      const event = item.message.envelope.eventName;
      events.push(`start:${event}`);
      if (event === 'AB') {
        started();
        await blocked;
      }
      events.push(`end:${event}`);
      return { status: 'ack' };
    });
    const ab = {
      definition: { projectionName: 'legacy' },
      message: {
        envelope: { projectionName: 'legacy', sourceStream: 'Order', sourceId: SOURCE_A, eventName: 'AB', payload: {} },
        routeDecision: { projectionName: 'legacy', targets: [
          { targetId: 'A', laneKey: 'legacy:A' }, { targetId: 'B', laneKey: 'legacy:B' }
        ] }
      }
    };
    const b = structuredClone(ab);
    b.message.envelope.eventName = 'B';
    b.message.routeDecision.targets = [{ targetId: 'B', laneKey: 'legacy:B' }];
    const runs = worker.pushMany([ab, b]);
    await didStart;
    expect(events).toEqual(['start:AB']);
    release();
    await runs;
    expect(events).toEqual(['start:AB', 'end:AB', 'start:B', 'end:B']);
  });

  test('returns retryable ambiguous outcomes and allows none to reexecute', async () => {
    const store = new MemoryCommitStore();
    const baseCommit = store.commitProjectionSourceCommit.bind(store);
    const unknown = jest.fn(async (request: CommitProjectionSourceCommitRequest<State>) => {
      store.commitProjectionSourceCommit = baseCommit;
      throw new Error('unknown transaction result');
    });
    store.commitProjectionSourceCommit = unknown;
    const runtime = coordinator([
      definition('none', { strategy: 'none', duplicateEffects: 'acknowledged', reason: 'unknown replay' })
    ], store);
    expect(await runtime.process(commit(0))).toMatchObject({ status: 'retryable', reason: 'unknown transaction result' });
    expect((await runtime.process(commit(0))).status).toBe('completed');
    expect(unknown).toHaveBeenCalledTimes(1);
  });

});
