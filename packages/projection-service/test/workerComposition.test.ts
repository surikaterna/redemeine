import { validateRegistrations } from '../src/definitionValidation';
import { applicationRegistry } from '../src/runtimeRegistry';
import { registryResourceFactory } from '../src/infrastructure/brokerWorkerRuntime';
import { bootstrapIdentity, preparedRecord, validateBootstrap } from '../src/infrastructure/bootstrapRecord';
import { brokerClients } from './support/brokerClients';
import { modelCommit } from '../src/reference/scenario';
import { externalConfig } from './support/mongoClient';
import { Observations } from '../src/observability';
import { SessionFence } from '../src/sessionFence';
import { until } from './support/deferred';
import type { ProjectionEvent, ProjectionSourceCommit } from '@redemeine/projection-runtime-core';
import { SealedArtifact } from '../src/artifactIdentity';
import { join } from 'node:path';
import { createMongoRegistryStores } from '../src/infrastructure/mongoRegistryStores';
import { storeFacade } from '../src/infrastructure/mongoWorker';
import { establishBinding } from '../src/infrastructure/liveBootstrap';
import { BrokerTopology } from '../src/infrastructure/brokerTopology';
import { ManagementFixture } from './support/brokerManagement';
import { loadDefinitionBundle } from '../src/definitionBundle';

afterEach(() => { jest.restoreAllMocks(); });
function input(name = 'ledger:inline', own = false) {
  return { initialization: 'suffix_contributions', routing: 'event_stable_commutative', definition: { name, subscriptions: [],
    initialState: () => ({ total: 0 }), identity: () => 'shared', ...(own ? { deduplication: { strategy: 'own_record' } } : {}),
    fromStream: { aggregate: { aggregateType: 'Ledger', initialState: {}, pure: { eventProjectors: {} } },
      handlers: { Credited: (state: { total: number }, event: ProjectionEvent) => { if (typeof event.payload.amount !== 'number') throw new Error('bad_credit'); state.total += event.payload.amount; } } } } };
}

test('supplied two application definitions reach actual coordinator/generic Mongo stores, generation and original ACK', async () => {
  const base = modelCommit(42); const commit: ProjectionSourceCommit = { ...base, events: [{ ...base.events[0], aggregateType: 'Ledger', type: 'Credited', payload: { amount: 5 } }] };
  const f = brokerClients(commit); f.early(); const digest = (await SealedArtifact.read(join(__dirname, '../dist-worker'))).digest;
  const app = applicationRegistry(digest, 'a'.repeat(64), validateRegistrations([input(), input('ledger:own', true)]));
  const resource = await registryResourceFactory(f.mongo.config, app.identity, app.registry, new Observations(), f.factories)(new AbortController().signal, new SessionFence());
  try {
    expect(f.mongo.createIndex).toHaveBeenCalledTimes(2); await resource.start(); await until(() => resource.worker.getStatus().activeDeliveries === 0);
    expect([...f.data.rows.values()].filter((row) => row.state && typeof row.state === 'object').map((row) => row.state)).toEqual([{ total: 5 }, { total: 5 }]);
    expect(f.connections[0]?.channel.ack).toHaveBeenCalledWith(f.message, false);
    expect(f.data.trace.indexOf('floor:42')).toBeLessThan(f.data.trace.indexOf('ack'));
  } finally { await resource.worker.stop(); await resource.close(); }
});

test('changed bundle/runtime/order/definition profile refuses bootstrap before adoption or mutation', () => {
  const config = externalConfig(); const defs = validateRegistrations([input(), input('ledger:own', true)]);
  const original = applicationRegistry('a'.repeat(64), 'b'.repeat(64), defs); const record = preparedRecord(bootstrapIdentity(config, original.identity));
  const changed = [applicationRegistry('c'.repeat(64), 'b'.repeat(64), defs), applicationRegistry('a'.repeat(64), 'c'.repeat(64), defs),
    applicationRegistry('a'.repeat(64), 'b'.repeat(64), [...defs].reverse()), applicationRegistry('a'.repeat(64), 'b'.repeat(64), validateRegistrations([input('ledger:other')]))];
  expect(validateBootstrap(record, bootstrapIdentity(config, original.identity)).registryDigest).toBe(original.identity.registryDigest);
  for (const app of changed) expect(() => validateBootstrap(record, bootstrapIdentity(config, app.identity))).toThrow('bootstrap_identity_mismatch');
});

test('generic store facade selects exact application name and persisted generation, rejecting unknowns', () => {
  const f = brokerClients(); const app = applicationRegistry('a'.repeat(64), 'b'.repeat(64), validateRegistrations([input()]));
  const stores = createMongoRegistryStores(f.mongo.seed.db('app'), f.mongo.seed, app.registry, 1000, 'epoch', 'broker:epoch');
  expect(stores.map((entry) => [entry.projectionName, entry.generation])).toEqual([['ledger:inline', 'broker:epoch']]);
  const facade = storeFacade(stores, () => {});
  const request = { projectionName: 'unknown', projectionGeneration: 'broker:epoch', targetDocumentIds: [], links: [], progressStrategy: 'in_document' as const };
  expect(() => facade.loadProjectionSourceCommitSnapshot(request)).toThrow('broker_definition_mismatch');
  expect(() => facade.loadProjectionSourceCommitSnapshot({ ...request, projectionName: 'ledger:inline', projectionGeneration: 'wrong' })).toThrow('broker_definition_mismatch');
});

test('changed existing application identity fails before any bootstrap/queue mutation', async () => {
  const config = externalConfig(); const defs = validateRegistrations([input()]);
  const first = applicationRegistry('a'.repeat(64), 'b'.repeat(64), defs); const record = preparedRecord(bootstrapIdentity(config, first.identity));
  const next = applicationRegistry('a'.repeat(64), 'c'.repeat(64), defs); const management = new ManagementFixture(config);
  management.declare(record.queueNonce); management.bind();
  const store = { load: jest.fn(async () => record), insert: jest.fn(async () => {}), replace: jest.fn(async () => {}) };
  const actions = { declare: jest.fn(async () => {}), bind: jest.fn(async () => {}) };
  await expect(establishBinding(config, next.identity, store, new BrokerTopology(config, management), actions, () => {})).rejects.toThrow('bootstrap_identity_mismatch');
  expect(actions.declare).not.toHaveBeenCalled(); expect(actions.bind).not.toHaveBeenCalled(); expect(store.insert).not.toHaveBeenCalled(); expect(store.replace).not.toHaveBeenCalled();
});

test('registry/identity mismatch refuses before driver acquisition', () => {
  const f = brokerClients(); const app = applicationRegistry('a'.repeat(64), 'b'.repeat(64), validateRegistrations([input()]));
  expect(() => registryResourceFactory(f.mongo.config, { ...app.identity, registryDigest: 'c'.repeat(64) }, app.registry, new Observations(), f.factories))
    .toThrow('broker_definition_mismatch');
  expect(f.connections).toHaveLength(0); expect(f.data.rows.size).toBe(0);
});

test.each(['handler', 'hook', 'initialState', 'identity'])('main loaded async %s pauses actual worker with no business writes, coverage or original ACK', async (boundary) => {
  const base = modelCommit(42); const commit: ProjectionSourceCommit = { ...base, events: [{ ...base.events[0], aggregateType: 'Ledger', type: 'Credited', payload: { amount: 5 } }] };
  const entry = input(); const asyncResult = () => Promise.reject(new Error('private_callback'));
  const definition = { ...entry.definition, ...(boundary === 'initialState' ? { initialState: asyncResult } : {}),
    ...(boundary === 'identity' ? { identity: asyncResult } : {}), ...(boundary === 'hook' ? { hooks: { afterEach: asyncResult } } : {}),
    fromStream: { ...entry.definition.fromStream, handlers: { Credited: boundary === 'handler' ? asyncResult : entry.definition.fromStream.handlers.Credited } } };
  const loaded = await loadDefinitionBundle(join(__dirname, '.built/application/definitions.mjs'), 2000, undefined,
    { importModule: async () => ({ registrations: [{ ...entry, definition }] }) });
  const app = applicationRegistry('a'.repeat(64), loaded.moduleHash, loaded.definitions); const f = brokerClients(commit); f.early();
  const resource = await registryResourceFactory(f.mongo.config, app.identity, app.registry, new Observations(), f.factories)(new AbortController().signal, new SessionFence());
  try {
    await resource.start(); await until(() => resource.worker.getStatus().activeDeliveries === 0);
    expect(resource.worker.getStatus()).toMatchObject({ accepting: false, reason: 'live_coordinator_paused' });
    expect(f.data.trace).not.toContain('document'); expect(f.data.trace).not.toContain('floor:42');
    expect(f.connections[0]?.channel.ack).not.toHaveBeenCalled();
    expect([...f.data.rows.values()].filter((row) => Object.hasOwn(row, 'coveredThrough'))).toEqual([expect.objectContaining({ firstSequence: 42, coveredThrough: null })]);
  } finally { await resource.worker.stop(); await resource.close(); }
});
