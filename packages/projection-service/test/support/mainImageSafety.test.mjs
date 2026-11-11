import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { superviseChild } from '../../scripts/main-image-child.mjs';
import { ImageResourceLedger } from '../../scripts/main-image-ledger.mjs';
import { assertDaemonCapabilities, assertContainerCapabilities } from '../../scripts/main-image-capabilities.mjs';

function childFixture(kill) {
  const child = new EventEmitter(); child.pid = 12345; child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kills = []; child.unref = () => { child.detached = true; };
  child.kill = (signal) => { child.kills.push(signal); return kill ? kill(child, signal) : false; };
  return child;
}
function supervised(child, extra = {}) { return superviseChild(child, { milliseconds: 10, graceMilliseconds: 20, limit: 100, ...extra }); }

test('PK1 postspawn EPERM cannot disable deadlines, settlement or finally cleanup', async () => {
  const child = childFixture(); let cleaned = false; const started = performance.now();
  const pending = supervised(child).finally(() => { cleaned = true; });
  child.emit('error', Object.assign(new Error('private://canary'), { code: 'EPERM' }));
  const result = await pending;
  assert.equal(result.reason, 'command_child_error'); assert.equal(result.cliJoined, false);
  assert.ok(cleaned && child.detached); assert.deepEqual(child.kills, ['SIGTERM', 'SIGKILL']);
  assert.ok(performance.now() - started < 1000); assert.ok(!JSON.stringify(result).includes('canary'));
  child.emit('error', new Error('late')); child.emit('close', 0, null);
});
test('PK1 independent terminating latch prevents synchronous kill/error recursion and repeated errors', async () => {
  const child = childFixture((current) => { current.emit('error', new Error('EPERM')); throw new Error('private'); });
  const pending = supervised(child); child.emit('error', new Error('first'));
  for (let n = 0; n < 20; n++) child.emit('error', new Error('repeated'));
  const result = await pending;
  assert.equal(result.reason, 'command_child_error'); assert.equal(result.cliJoined, false);
  assert.deepEqual(child.kills, ['SIGTERM', 'SIGKILL']); assert.deepEqual(result.secondary, ['signal_failed', 'signal_failed']);
});
for (const stream of ['stdout', 'stderr']) test(`PK1 ${stream} error is observed and joined failure preserves first cause`, async () => {
  const child = childFixture(); const pending = supervised(child);
  child[stream].emit('error', new Error('private')); child.emit('error', new Error('second')); child.emit('close', 1, null);
  const result = await pending; assert.equal(result.reason, 'command_pipe_error'); assert.equal(result.cliJoined, true);
  child[stream].emit('error', new Error('late'));
});
test('PK1 throwing signals and no close have finite explicit unjoined outcome', async () => {
  const child = childFixture(() => { throw new Error('private'); }); const result = await supervised(child);
  assert.equal(result.reason, 'command_timeout'); assert.equal(result.cliJoined, false); assert.equal(result.secondary.length, 2);
});
test('PK1 close after original deadline cannot pass when native timer has not run', async () => {
  let now = 0; const child = childFixture(); const pending = supervised(child, { now: () => now });
  now = 11; child.emit('close', 0, null); const result = await pending;
  assert.equal(result.reason, 'command_timeout'); assert.equal(result.cliJoined, true); assert.deepEqual(child.kills, []);
});
test('PK1 late close after original termination grace remains unjoined', async () => {
  let now = 0; const child = childFixture(); const pending = supervised(child, { now: () => now });
  child.emit('error', new Error('first')); now = 21; child.emit('close', 0, null);
  const result = await pending; assert.equal(result.reason, 'command_child_error'); assert.equal(result.cliJoined, false);
});
test('PK1 abort/SIGTERM mapping still terminates after a primary error', async () => {
  const child = childFixture(); const controller = new AbortController(); const pending = supervised(child, { signal: controller.signal });
  child.emit('error', new Error('first')); controller.abort(); const result = await pending;
  assert.equal(result.reason, 'command_child_error'); assert.equal(result.cliJoined, false); assert.equal(child.kills.length, 2);
  const next = childFixture(); const signal = new AbortController(); const interrupted = supervised(next, { signal: signal.signal });
  const handler = () => signal.abort(); process.once('SIGTERM', handler); process.emit('SIGTERM');
  assert.equal((await interrupted).reason, 'packaging_interrupted');
});
test('PK1 known native ENOENT is no-spawn; post-spawn error is not', async () => {
  const child = childFixture(); child.pid = undefined; const pending = supervised(child);
  child.emit('error', Object.assign(new Error('secret'), { code: 'ENOENT' }));
  const result = await pending; assert.equal(result.nativeNoSpawn, true); assert.equal(result.cliJoined, true); assert.equal(child.kills.length, 0);
  const live = childFixture(); live.pid = undefined; const next = supervised(live); live.emit('spawn'); live.emit('error', { code: 'ENOENT' });
  assert.equal((await next).nativeNoSpawn, false);
});
test('PK1 overflow is bounded and observed; normal close retains bounded output', async () => {
  const child = childFixture(); const pending = supervised(child, { limit: 3 }); child.stdout.write(Buffer.from('private'));
  const result = await pending; assert.equal(result.reason, 'command_output_capacity'); assert.equal(result.stdout.length, 0);
  const next = childFixture(); const normal = supervised(next); next.stdout.write('ok'); next.emit('close', 0, null);
  assert.equal((await normal).stdout.toString(), 'ok');
});
test('PK1 original pre-spawn deadline is not inflated', async () => {
  const child = childFixture(); const pending = supervised(child, { deadline: 0, now: () => 1 });
  child.emit('close', 0, null); assert.equal((await pending).reason, 'command_timeout');
});
test('PK1 failed/unjoined CLI cannot keep runner alive after finally/receipt', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pk1-exit-')); const path = join(directory, 'receipt.json');
  const source = `import {EventEmitter} from 'node:events';import {PassThrough} from 'node:stream';
    import {writeFile} from 'node:fs/promises';
    import {superviseChild,armFailureExit} from ${JSON.stringify(new URL('../../scripts/main-image-child.mjs', import.meta.url).href)};
    const c=new EventEmitter();c.pid=123;c.stdout=new PassThrough();c.stderr=new PassThrough();
    c.kill=()=>{throw Error('EPERM')};c.unref=()=>{throw Error('EPERM')};setInterval(()=>{},100);
    let cleanup=false;const result=await superviseChild(c,{milliseconds:1,graceMilliseconds:10,limit:100}).finally(()=>{cleanup=true});
    await writeFile(${JSON.stringify(path)},JSON.stringify({cleanup,cliJoined:result.cliJoined,status:'failed_uncertain'}),{mode:0o600});
    process.exitCode=1;armFailureExit();`;
  try {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8', timeout: 5000 });
    assert.equal(child.status, 1); assert.equal(child.signal, null); assert.equal(child.stderr, '');
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { cleanup: true, cliJoined: false, status: 'failed_uncertain' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

const plan = { image: 'main:unique', directory: '/tmp/opencode/owned', labels: { issue: 'hpq1.2', run: 'unique', source: 'freeze' },
  containers: [{ kind: 'missing', name: 'missing' }, { kind: 'invalid', name: 'invalid' }] };
function row(entry, id = 'a'.repeat(64)) {
  return { Id: id, Name: `/${entry.name}`, RepoTags: [entry.name], Config: { Labels: { ...plan.labels } } };
}
async function clean(ledger, rows, removals = [], uncertainty = []) {
  const records = []; await ledger.cleanup(async (_type, name) => rows.get(name) ?? null,
    async (entry, id) => { removals.push({ name: entry.name, id }); rows.delete(entry.name); },
    (record) => records.push(record), (record) => uncertainty.push(record), () => {});
  return { records, removals, uncertainty };
}
for (const name of ['main:unique', 'missing', 'invalid']) test(`PK2 preflight ${name} collision creates/removes nothing even with matching labels`, async () => {
  const ledger = new ImageResourceLedger(plan); const entry = ledger.entries.find((entry) => entry.name === name);
  const rows = new Map([[name, row(entry)]]);
  await assert.rejects(ledger.preflight(async (_type, name) => rows.get(name) ?? null), /preexisting_resource_refused/);
  const result = await clean(ledger, rows); assert.equal(result.removals.length, 0); assert.equal(result.uncertainty.length, 0);
  assert.ok(ledger.entries.every((entry) => !entry.attempted));
});
for (const type of ['image', 'container']) test(`PK2 same-label ${type} replacement ID refuses removal`, async () => {
  const ledger = new ImageResourceLedger(plan); await ledger.preflight(async () => null);
  const entry = ledger.intent(type, type === 'image' ? plan.image : 'missing'); ledger.identify(entry, row(entry));
  const rows = new Map([[entry.name, row(entry, 'b'.repeat(64))]]); const result = await clean(ledger, rows);
  assert.equal(result.removals.length, 0); assert.equal(result.uncertainty[0].reason, 'cleanup_not_proven');
});
test('PK2 legitimate confirmed three-resource cleanup compares every ID', async () => {
  const ledger = new ImageResourceLedger(plan); await ledger.preflight(async () => null); const rows = new Map();
  for (const [index, declared] of ledger.entries.entries()) {
    const entry = ledger.intent(declared.type, declared.name); const actual = row(entry, String(index + 1).repeat(64));
    ledger.identify(entry, actual); rows.set(entry.name, actual);
  }
  const result = await clean(ledger, rows); assert.equal(result.removals.length, 3); assert.equal(result.uncertainty.length, 0);
  assert.ok(result.records.every((row) => row.removed && row.daemonCompletionProven));
});
for (const type of ['image', 'container']) test(`PK2 partial ${type} completion can reconcile only attempted name and stays uncertain`, async () => {
  const ledger = new ImageResourceLedger(plan); await ledger.preflight(async () => null);
  const entry = ledger.intent(type, type === 'image' ? plan.image : 'missing'); ledger.failed(entry, { nativeNoSpawn: false });
  const result = await clean(ledger, new Map([[entry.name, row(entry)]]));
  assert.equal(result.removals.length, 1); assert.equal(result.uncertainty[0].reason, 'daemon_completion_unproven');
  assert.equal(result.records[0].daemonCompletionProven, false);
});
test('PK2 single absent inspection cannot prove canceled daemon work or remove a late object', async () => {
  const ledger = new ImageResourceLedger(plan); await ledger.preflight(async () => null);
  const entry = ledger.intent('image', plan.image); ledger.failed(entry, {}); const rows = new Map();
  const result = await clean(ledger, rows); rows.set(entry.name, row(entry)); await delay(1);
  assert.equal(result.removals.length, 0); assert.equal(result.records[0].daemonCompletionProven, false); assert.equal(result.uncertainty.length, 1);
});
test('PK2 native no-spawn abandons intent without adopting/removing any resource', async () => {
  const ledger = new ImageResourceLedger(plan); await ledger.preflight(async () => null);
  const entry = ledger.intent('image', plan.image); ledger.failed(entry, { nativeNoSpawn: true });
  assert.equal((await clean(ledger, new Map([[entry.name, row(entry)]]))).removals.length, 0);
});

function daemon() { return { OSType: 'linux', MemoryLimit: true, SwapLimit: true, CpuCfsQuota: true, CpuCfsPeriod: true, PidsLimit: true }; }
for (const field of Object.keys(daemon())) test(`PK3 unsupported daemon ${field} refuses before build`, () => {
  const info = daemon(); info[field] = false; let builds = 0;
  assert.throws(() => { assertDaemonCapabilities(info); builds++; }); assert.equal(builds, 0);
});
function containerMetadata(kind = 'missing') {
  return { Image: 'image-id', Name: `/${kind}`, Config: { User: '10001:10001', Entrypoint: ['/usr/bin/tini', '-g', '--', 'node', '/app/main.js'], Volumes: null },
    HostConfig: { Memory: 536870912, MemorySwap: 536870912, NanoCpus: 500000000, PidsLimit: 128, ReadonlyRootfs: true, Privileged: false,
      CapDrop: ['ALL'], CapAdd: null, SecurityOpt: ['no-new-privileges'], LogConfig: { Type: 'local', Config: { 'max-size': '1m', 'max-file': '2' } },
      NetworkMode: 'none', PublishAllPorts: false, PortBindings: null, Tmpfs: { '/tmp': 'rw,nosuid,nodev,noexec,size=16m' } },
    NetworkSettings: { Networks: { none: {} }, Ports: { '9464/tcp': null } },
    Mounts: kind === 'invalid' ? [{ Type: 'bind', Source: `${plan.directory}/invalid.mjs`, Destination: '/app/definitions/invalid.mjs', RW: false, Propagation: 'rprivate' }] : [] };
}
const wrong = { Memory: 0, MemorySwap: -1, NanoCpus: 0, PidsLimit: -1, ReadonlyRootfs: false, Privileged: true,
  CapDrop: [], CapAdd: ['SYS_ADMIN'], SecurityOpt: [], LogConfig: { Type: 'json-file', Config: {} }, NetworkMode: 'host',
  PublishAllPorts: true, PortBindings: { '9464/tcp': [{ HostPort: '9464' }] }, Tmpfs: { '/tmp': 'rw,size=32m' } };
for (const [key, value] of Object.entries(wrong)) test(`PK3 actual ${key} mismatch refuses`, () => {
  const row = containerMetadata(); row.HostConfig[key] = value;
  assert.throws(() => assertContainerCapabilities(row, plan.containers[0], plan, 'image-id'));
});
test('PK3 valid inspected caps and readonly owned mount pass, not only configured argv', () => {
  assertDaemonCapabilities(daemon());
  for (const container of plan.containers) assertContainerCapabilities(containerMetadata(container.kind), container, plan, 'image-id');
});
for (const field of ['RW', 'Source', 'Destination', 'Propagation']) test(`PK3 actual invalid bundle mount ${field} mismatch refuses`, () => {
  const row = containerMetadata('invalid'); row.Mounts[0][field] = field === 'RW' ? true : 'foreign';
  assert.throws(() => assertContainerCapabilities(row, plan.containers[1], plan, 'image-id'));
});
test('PK3 implicit volumes, extra networks and actual published ports refuse', () => {
  const mutations = [(row) => { row.Config.Volumes = { '/state': {} }; }, (row) => { row.NetworkSettings.Networks.bridge = {}; },
    (row) => { row.NetworkSettings.Ports['9464/tcp'] = [{ HostPort: '9464' }]; }, (row) => { row.Mounts.push({ Type: 'volume' }); }];
  for (const mutate of mutations) { const row = containerMetadata(); mutate(row); assert.throws(() => assertContainerCapabilities(row, plan.containers[0], plan, 'image-id')); }
});
