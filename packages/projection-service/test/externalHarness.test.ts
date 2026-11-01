import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Collection, MongoClient, ObjectId } from 'mongodb';
import * as ts from 'typescript';
import { assertLocalDaemon, exchangeName, queueName, requireApproval, resourceName, validateRunId } from '../integration/plan';
import { FixtureDb, fixtureEvent, SourceFixtures } from '../integration/fixtures';
import { Commands, type Executor } from '../integration/commands';
import { OwnedDocker, verifyOwner, verifyContainerCaps } from '../integration/docker';
import { Receipts, sanitizedLogs } from '../integration/receipts';
import { boundedJoin } from '../integration/schema';

const runId = '0123456789ab'; const id = 'a'.repeat(64);
const labels = { 'redemeine.issue': 'redemeine-hpq1.1', 'redemeine.run': runId };

test('proposed exchange/queue names stay distinct and fixed; only vhost/resources vary by qualification run', () => {
  expect(exchangeName).toBe('tapeworm.master.commits'); expect(queueName).toBe('rdm.projection.commits');
  expect(resourceName(runId, 'projection')).toBe('hpq1-0123456789ab-projection');
  expect(() => resourceName(runId, '../production')).toThrow();
  expect(() => validateRunId('production')).toThrow();
});

test('execution requires explicit review flag plus exact digest and valid run ID, with no remote Docker override', () => {
  const digest = 'b'.repeat(64);
  const env = { HPQ1_ALLOW_DOCKER: 'external-broker-live-v1-reviewed', HPQ1_PREAUDIT_SHA256: digest, HPQ1_RUN_ID: runId };
  expect(requireApproval(env, digest)).toBe(runId);
  expect(() => requireApproval({}, digest)).toThrow('qualification_execution_not_approved');
  expect(() => requireApproval({ ...env, HPQ1_PREAUDIT_SHA256: 'c'.repeat(64) }, digest)).toThrow();
  expect(() => requireApproval({ ...env, DOCKER_HOST: 'tcp://production:2375' }, digest)).toThrow();
  expect(() => assertLocalDaemon('ssh://production')).toThrow();
  expect(() => assertLocalDaemon('unix:///var/run/docker.sock')).not.toThrow();
});

test('actual source API fixture uses ISO event schema and a fixed driver Db collection mapping, without connecting', async () => {
  const client = new MongoClient('mongodb://127.0.0.1:1');
  try {
    const db = new FixtureDb(client, 'qualification');
    expect(db.collection('tw_master_commits').collectionName).toBe('commits');
    expect(db.collection('tw_master_snapshots').collectionName).toBe('tw_master_snapshots');
    const event = fixtureEvent({ amount: 2 });
    expect(event).toMatchObject({ type: 'Added', aggregateType: 'ModelCounter', aggregateId: 'fixture',
      timestamp: '2026-09-30T00:00:00.000Z', payload: { amount: 2, target: 'shared' } });
    expect(() => fixtureEvent({ amount: -1 })).toThrow();
  } finally { await client.close(); }
});

test('actual Tapeworm append API delegates to actual Mongo persistence and assigns commit/event versions with injected driver I/O', async () => {
  const client = new MongoClient('mongodb://127.0.0.1:1');
  const cursor = client.db('qualification').collection('commits').find();
  let stored: Record<string, unknown> | undefined;
  jest.spyOn(Collection.prototype, 'createIndex').mockResolvedValue('fixture-index');
  jest.spyOn(Collection.prototype, 'find').mockReturnValue(cursor);
  jest.spyOn(cursor, 'toArray').mockResolvedValue([]);
  const insert = jest.spyOn(Collection.prototype, 'insertOne').mockImplementation(async (row) => {
    stored = { ...row }; return { acknowledged: true, insertedId: new ObjectId() };
  });
  jest.spyOn(Collection.prototype, 'findOne').mockImplementation(async () => stored ? { ...stored, _id: new ObjectId() } : null);
  try {
    const source = await SourceFixtures.open(client, 'qualification', new AbortController().signal);
    const commit = await source.append('primary', [{ amount: 2 }, { amount: 3 }]);
    expect(commit.sequence).toBe(0); expect(insert).toHaveBeenCalledTimes(1);
    expect(stored).toMatchObject({ id: commit.commitId, streamId: commit.sourceId, partitionId: 'master', commitSequence: 0,
      events: [{ type: 'Added', version: 0 }, { type: 'Added', version: 1 }] });
    expect(stored?.token).toBeDefined(); expect(stored?.createDateTime).toBeInstanceOf(Date);
  } finally { jest.restoreAllMocks(); await client.close(); }
});

test('log receipts omit credentials, payloads, stacks and arbitrary reason values, not merely regex-redact them', () => {
  const raw = `${JSON.stringify({ phase: 'external_active', liveConsumerReady: true, reason: 'secret_canary',
    password: 'secret-canary', payload: { amount: 'secret-canary' } })}\nURI amqp://user:secret-canary@production\n`;
  const sanitized = sanitizedLogs(raw);
  expect(sanitized).toContain('external_active'); expect(sanitized).not.toMatch(/secret.canary|amqp|password|payload/);
});

test('exact resource label and identity checks refuse foreign objects even when names resemble this run', () => {
  const resource = { kind: 'container' as const, name: resourceName(runId, 'projection'), id, removed: false };
  expect(() => verifyOwner({ Id: id, Config: { Labels: labels } }, resource, runId)).not.toThrow();
  expect(() => verifyOwner({ Id: id, Config: { Labels: { ...labels, 'redemeine.run': 'other' } } }, resource, runId)).toThrow('resource_owner_mismatch');
  expect(() => verifyOwner({ Id: 'c'.repeat(64), Config: { Labels: labels } }, resource, runId)).toThrow('resource_identity_changed');
});

test('inspect metadata must confirm memory/CPU/PID/log bounds and nonroot read-only projection packaging', () => {
  const value = { Config: { User: '10001:10001' }, HostConfig: { Memory: 536870912, MemorySwap: 536870912, NanoCpus: 500000000,
    PidsLimit: 128, Privileged: false, ReadonlyRootfs: true, LogConfig: { Type: 'local', Config: { 'max-size': '10m', 'max-file': '2' } } } };
  expect(() => verifyContainerCaps(value, 'projection')).not.toThrow();
  expect(() => verifyContainerCaps({ ...value, HostConfig: { ...value.HostConfig, Privileged: true } }, 'projection')).toThrow();
  expect(() => verifyContainerCaps({ ...value, Config: { User: 'root' } }, 'projection')).toThrow();
});

test.each([true, false])('offline cleanup uses only exact owned ID; foreign=%s never triggers removal', async (foreign) => {
  const root = await mkdtemp('/tmp/opencode/hpq1-ledger-test-');
  const mutableCalls: string[][] = [];
  const executor: Executor = async (_binary, args) => {
    mutableCalls.push([...args]);
    return { code: 0, signal: null, stderr: '', stdout: args[1] === 'inspect'
      ? JSON.stringify([{ Id: id, Config: { Labels: { ...labels, 'redemeine.run': foreign ? 'other' : runId }, Env: ['PASSWORD=secret-canary'] },
        State: { Running: false, ExitCode: 0 } }]) : id };
  };
  try {
    const receipt = new Receipts(root, runId);
    receipt.resources.push({ kind: 'container', name: resourceName(runId, 'projection'), id, removed: false });
    await new OwnedDocker(new Commands(root, receipt, executor), receipt).cleanup(new AbortController().signal);
    expect(mutableCalls.some((args) => args[1] === 'rm')).toBe(!foreign);
    if (!foreign) expect(mutableCalls.at(-1)).toEqual(['container', 'rm', id]);
    expect(JSON.stringify(receipt)).not.toContain('secret-canary');
    expect(receipt.resources[0]?.removed).toBe(!foreign);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('bounded join observes late rejection without extending cleanup deadline', async () => {
  const controller = new AbortController(); let reject: (error: unknown) => void = () => {};
  const task = new Promise<void>((_resolve, no) => { reject = no; });
  const joined = boundedJoin(task, controller.signal); controller.abort();
  expect(await joined).toBe(false); reject(new Error('late')); await Promise.resolve();
});

test('compiled harness refuses absent approval before Docker or any service connection', () => {
  const result = spawnSync(process.execPath, [join(__dirname, '../integration/.built/externalStack.js')], {
    env: {}, encoding: 'utf8', timeout: 2000
  });
  expect(result.error).toBeUndefined(); expect(result.status).toBe(78); expect(result.stderr).toBe('');
  expect(JSON.parse(result.stdout)).toEqual({ issue: 'redemeine-hpq1.1', reason: 'qualification_execution_not_approved' });
});

test('new harness modules obey source limits and named/typed exports; configuration default convention only', async () => {
  const root = join(__dirname, '../integration');
  for (const name of await readdir(root)) {
    if (!name.endsWith('.ts') || name.endsWith('.config.ts')) continue;
    const content = await readFile(join(root, name), 'utf8'); expect(content.split('\n').length).toBeLessThanOrEqual(350);
    const source = ts.createSourceFile(name, content, ts.ScriptTarget.Latest, true);
    const violations: string[] = [];
    function inspect(node: ts.Node): void {
      if (node.kind === ts.SyntaxKind.AnyKeyword) violations.push('any');
      if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isExportAssignment(node)) violations.push('cast_or_default_export');
      if (ts.isFunctionLike(node)) {
        const start = source.getLineAndCharacterOfPosition(node.getStart(source)).line;
        const end = source.getLineAndCharacterOfPosition(node.getEnd()).line;
        if (end - start + 1 >= 50) violations.push('function_size');
      }
      ts.forEachChild(node, inspect);
    }
    inspect(source);
    expect(violations).toEqual([]);
  }
});
