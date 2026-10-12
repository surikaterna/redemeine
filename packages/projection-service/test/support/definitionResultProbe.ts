import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createLiveCommitCoordinator } from '@redemeine/projection-worker-core';
import type { LiveSourcePosition, ProjectionSourceCommit, ProjectionSourceCommitStorePort } from '@redemeine/projection-runtime-core';
import { loadDefinitionBundle } from '../../src/definitionBundle';
import { applicationRegistry } from '../../src/runtimeRegistry';
import { modelCommit } from '../../src/reference/scenario';

const expressions: Record<string, string> = {
  synchronous: '(state) => state.total += 5',
  before_await: 'async state => { state.total += 5; await Promise.resolve(); state.total += 1; }',
  after_await: 'async state => { await Promise.resolve(); state.total += 5; }',
  ordinary_promise: 'state => Promise.resolve().then(() => { state.total += 5; })',
  rejected: '() => Promise.reject(new Error("private://callback"))',
  resolving_thenable: '() => ({ then(resolve) { resolve(5); } })',
  rejecting_thenable: '() => ({ then(_resolve, reject) { reject(new Error("private://thenable")); } })',
  stuck_thenable: '() => ({ then() {} })',
  hostile_thenable: '() => ({ then(resolve, reject) { reject(new Error("private")); resolve(5); throw new Error("private"); } })',
  throwing_getter: '() => Object.defineProperty({}, "then", { get() { throw new Error("private://getter"); } })',
  cross_realm: `() => runInNewContext('Promise.reject(new Error("private"))')`,
  native_getter: '() => Object.defineProperty(Promise.reject(new Error("private")), "then", { get() { throw new Error("private"); } })'
};

function moduleSource(boundary: string, kind: string) {
  const expression = expressions[kind]; if (!expression) throw new Error('invalid_probe');
  const handler = boundary === 'handler' ? expression : 'state => state.total += 5';
  const hook = boundary === 'hook' ? `, hooks: { afterEach: ${expression} }` : '';
  const initial = boundary === 'initialState' ? expression : '() => ({ total: 0 })';
  const identity = boundary === 'identity' ? expression : '() => "shared"';
  return `import {runInNewContext} from 'node:vm'; export const registrations = [{ initialization: 'suffix_contributions', routing: 'event_stable_commutative', definition: {
    name: 'ledger:probe', subscriptions: [], initialState: ${initial}, identity: ${identity}${hook},
    fromStream: { aggregate: { aggregateType: 'Ledger', initialState: {}, pure: { eventProjectors: {} } }, handlers: { Credited: ${handler} } } } }];`;
}

async function probe(path: string) {
  const loaded = await loadDefinitionBundle(path, 2000); const app = applicationRegistry('a'.repeat(64), loaded.moduleHash, loaded.definitions);
  const base = modelCommit(42); const commit: ProjectionSourceCommit = { ...base, events: [{ ...base.events[0], aggregateType: 'Ledger', type: 'Credited', payload: { amount: 5 } }] };
  const position: LiveSourcePosition = { epoch: 'epoch', registryDigest: app.identity.registryDigest, sourceId: commit.streamId,
    firstSequence: 42, firstCommitId: commit.commitId, coveredThrough: null };
  let writes = 0; let advances = 0; let persisted: unknown = null;
  const store: ProjectionSourceCommitStorePort<unknown> = {
    loadProjectionSourceCommitSnapshot: async () => ({ targets: [{ targetDocumentId: 'shared', state: null, revision: null, sourceProgress: {} }], links: [], ownRecordSequence: null }),
    commitProjectionSourceCommit: async (request) => { writes++; persisted = structuredClone(request.finalDocuments[0]?.finalDocument); return { version: 1, status: 'committed', commitSequence: 42, documentRevisions: {}, linkRevisions: {}, progress: request.progress }; }
  };
  const coordinator = createLiveCommitCoordinator({ epoch: 'epoch', registryDigest: app.identity.registryDigest,
    definitions: app.registry.definitions('broker:epoch'), store, sourceOrder: { load: async () => position,
      admitFirst: async () => { throw new Error('unexpected_admission'); }, advanceCoverage: async (p, sequence) => { advances++; return { ...p, coveredThrough: sequence }; } },
    rangeReader: { capability: { completeCommitBoundaries: true, unslicedCommitEvents: true }, readCompleteRange: async () => { throw new Error('unexpected_range'); } },
    budget: { maxCommits: 10, maxBytes: 100000, maxMilliseconds: 1000, maxEventsPerCommit: 10 } });
  const result = await coordinator.process(commit, position, () => {}); await delay(30);
  return { result, writes, advances, persisted, floor: position };
}

async function main() {
  let unhandled = 0; process.on('unhandledRejection', () => { unhandled++; });
  const directory = await mkdtemp(join(tmpdir(), 'definition-result-')); const path = join(directory, 'app.mjs');
  try {
    await writeFile(path, moduleSource(process.argv[2] ?? '', process.argv[3] ?? ''));
    console.log(JSON.stringify({ ...await probe(path), unhandled }));
  } finally { await rm(directory, { recursive: true, force: true }); }
}
void main().catch(() => { console.log(JSON.stringify({ error: 'probe_failed' })); process.exitCode = 1; });
