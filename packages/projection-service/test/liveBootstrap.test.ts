import { BrokerTopology } from '../src/infrastructure/brokerTopology';
import { isDeepStrictEqual } from 'node:util';
import { bootstrapIdentity, type BootstrapRecord } from '../src/infrastructure/bootstrapRecord';
import { establishBinding, claimBootstrapRun, finishBootstrapRun, type BootstrapStore } from '../src/infrastructure/liveBootstrap';
import { builtArtifact } from './fixtures';
import { externalConfig } from './support/mongoClient';
import { ManagementFixture } from './support/brokerManagement';

class MemoryControl implements BootstrapStore {
  row: BootstrapRecord | null = null;
  insertFault: 'before' | 'after' | undefined;
  replaceFault: 'before' | 'after' | undefined;
  readonly trace: string[] = [];
  async load() { return this.row; }
  async insert(record: BootstrapRecord) {
    this.trace.push('prepared');
    if (this.insertFault === 'before') throw new Error('uncertain');
    this.row = record;
    if (this.insertFault === 'after') throw new Error('uncertain');
  }
  async replace(expected: BootstrapRecord, next: BootstrapRecord) {
    this.trace.push(next.state);
    if (!isDeepStrictEqual(this.row, expected) || this.replaceFault === 'before') throw new Error('uncertain');
    this.row = next;
    if (this.replaceFault === 'after') throw new Error('uncertain');
  }
}

async function fixture() {
  const config = externalConfig(); const artifact = await builtArtifact(); const store = new MemoryControl();
  const management = new ManagementFixture(config); const topology = new BrokerTopology(config, management);
  const actions = { declare: jest.fn(async (nonce: string) => { store.trace.push('declare'); management.declare(nonce); }),
    bind: jest.fn(async () => { store.trace.push('bind'); management.bind(); }) };
  const run = () => establishBinding(config, artifact, store, topology, actions, () => {});
  return { config, artifact, store, management, topology, actions, run };
}

test('persists prepared before declaring, binds/inspects before bound; stable key excludes artifact identity', async () => {
  const f = await fixture(); const record = await f.run();
  expect(f.store.trace).toEqual(['prepared', 'declare', 'bind', 'bound']);
  expect(record).toMatchObject({ state: 'bound', runState: 'clean', runId: null });
  expect(record.generation).toBe(`broker:${record.epoch}`);
  expect(record.generation).not.toContain('model:');
  expect(JSON.stringify(record)).not.toContain('secret-canary');
  expect(bootstrapIdentity({ ...f.config, external: { ...f.config.external, partitionId: 'changed' } }, f.artifact)._id).toBe(record._id);
});

test.each(['insert_before', 'insert_after', 'declare_before', 'declare_after', 'bind_before', 'bind_after', 'bound_before', 'bound_after'])('bootstrap crash boundary %s never adopts/recreates or silently rebinds', async (fault) => {
  const f = await fixture();
  if (fault === 'insert_before') f.store.insertFault = 'before';
  if (fault === 'insert_after') f.store.insertFault = 'after';
  if (fault === 'declare_before') f.actions.declare.mockRejectedValue(new Error('crash'));
  if (fault === 'declare_after') f.actions.declare.mockImplementation(async (nonce) => { f.management.declare(nonce); throw new Error('crash'); });
  if (fault === 'bind_before') f.actions.bind.mockRejectedValue(new Error('crash'));
  if (fault === 'bind_after') f.actions.bind.mockImplementation(async () => { f.management.bind(); throw new Error('crash'); });
  if (fault === 'bound_before') f.store.replaceFault = 'before';
  if (fault === 'bound_after') f.store.replaceFault = 'after';
  const result = await f.run().catch(() => null);
  if (['insert_after', 'bound_after'].includes(fault)) expect(result?.state).toBe('bound');
  else expect(result).toBeNull();
  f.store.insertFault = undefined; f.store.replaceFault = undefined;
  f.actions.declare.mockClear(); f.actions.bind.mockClear();
  if (['bind_after', 'bound_before', 'bound_after', 'insert_after'].includes(fault)) expect((await f.run()).state).toBe('bound');
  else if (fault !== 'insert_before') await expect(f.run()).rejects.toThrow();
  expect(f.actions.declare).not.toHaveBeenCalled(); expect(f.actions.bind).not.toHaveBeenCalled();
});

test('unregistered queue, lost bound queue and changed scope all refuse without topology mutation', async () => {
  const f = await fixture(); f.management.declare('unregistered');
  await expect(f.run()).rejects.toThrow('unregistered_queue'); expect(f.store.row).toBeNull();
  f.management.queueValue = null; const record = await f.run();
  f.actions.declare.mockClear(); f.actions.bind.mockClear(); f.management.queueValue = null;
  await expect(f.run()).rejects.toThrow('established_queue_missing');
  f.management.declare(record.queueNonce); f.management.bind();
  await expect(establishBinding({ ...f.config, external: { ...f.config.external, partitionId: 'other' } }, f.artifact,
    f.store, f.topology, f.actions, () => {})).rejects.toThrow('bootstrap_identity_mismatch');
  expect(f.actions.declare).not.toHaveBeenCalled(); expect(f.actions.bind).not.toHaveBeenCalled();
});

test('unclean prior run is quarantined; same process reconnect and clean restart retain epoch', async () => {
  const f = await fixture(); const bound = await f.run();
  const first = '00000000-0000-4000-8000-000000000001'; const second = '00000000-0000-4000-8000-000000000002';
  const active = await claimBootstrapRun(f.store, bound, first);
  expect(await claimBootstrapRun(f.store, active, first)).toBe(active);
  await expect(claimBootstrapRun(f.store, active, second)).rejects.toThrow('restart_reconciliation_required');
  await finishBootstrapRun(f.store, active);
  const record = f.store.row; if (!record) throw new Error('missing_record');
  expect((await claimBootstrapRun(f.store, record, second)).epoch).toBe(bound.epoch);
});
