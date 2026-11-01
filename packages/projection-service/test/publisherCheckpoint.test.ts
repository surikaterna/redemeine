import { BSON, Collection, MongoClient, Timestamp } from 'mongodb';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { checkpointFacts, checkpointSummary } from '../integration/checkpointDiagnostics';
import { publisherFeed, publisherStateCollection, publisherCheckpointKey, QualificationError } from '../integration/plan';
import { publisherLogFacts } from '../integration/publisherLogs';
import { sanitizedLogs, Receipts } from '../integration/receipts';
import { Observations } from '../integration/observations';
import { OwnedDocker } from '../integration/docker';
import { Commands, type Executor } from '../integration/commands';
import { BrokerHttp } from '../integration/http';
import { producerWait } from '../integration/scenarioDiagnostics';

const runId = 'b79c31a58d24'; const feed = publisherFeed(runId); const id = 'a'.repeat(64);
const boundary = { _id: publisherCheckpointKey, version: 1, feed, updatedAt: new Date('2026-09-30T00:00:00Z'),
  primary: { kind: 'boundary', mode: 'changeStream', ts: new Timestamp({ t: 100, i: 1 }) } };

test('native v1 BSON boundary retains Timestamp/Date and exact string key/canonical feed contract', () => {
  const row: unknown = BSON.deserialize(BSON.serialize(boundary));
  expect(feed).toBe('["hpq1_b79c31a58d24","hpq1_b79c31a58d24","commits","changeStream","tapeworm.master.commits",null]');
  expect(checkpointFacts(row, feed)).toMatchObject({ status: 'present', versionOne: true, feedMatches: true,
    updatedAtIsDate: true, primaryKind: 'boundary', primaryValid: true, hasUuidProgress: false });
  expect(checkpointSummary(row, feed)).toMatchObject({ kind: 'boundary', hasUuidProgress: false });
  expect(checkpointSummary({ ...boundary, lastCommitToken: null }, feed)?.hasUuidProgress).toBe(false);
});

test.each([null, { _id: publisherCheckpointKey }])('absent or missingprimary remains unready,not fabricated boundary: %j', (row) => {
  expect(checkpointSummary(row, feed)).toBeNull();
});

test.each([64, 'secret-canary', { ...boundary, version: 0 }, { ...boundary, feed: 'other' },
  { ...boundary, updatedAt: '2026-09-30' }, { ...boundary, primary: { kind: 'boundary', mode: 'changeStream', ts: 100 } },
  { ...boundary, primary: { kind: 'secret-canary' } }, { ...boundary, primary: { kind: 'changeStream', token: {} } },
  { ...boundary, primary: { kind: 'changeStream', token: { _replayFallback: true } } }])
('wrongnativecheckpointcontract is refused with safe facts: %j', (row) => {
  expect(() => checkpointSummary(row, feed)).toThrow('publisher_checkpoint_contract_invalid');
  expect(JSON.stringify(checkpointFacts(row, feed))).not.toContain('secret-canary');
});

test('native changeStream and UUID progress are observed without persisting opaque token/event data', () => {
  const row = { ...boundary, primary: { kind: 'changeStream', token: { _data: 'secret-canary' } },
    lastCommitToken: '00000000-0000-4000-8000-000000000001', credentials: 'secret-canary' };
  expect(checkpointSummary(row, feed)).toMatchObject({ kind: 'changeStream', hasUuidProgress: true });
  expect(JSON.stringify(checkpointFacts(row, feed))).not.toContain('secret-canary');
});

test('observer uses exact native collection/key and explicit primary majority query', async () => {
  const client = new MongoClient('mongodb://127.0.0.1:1');
  const find = jest.spyOn(Collection.prototype, 'findOne').mockResolvedValue(boundary);
  const receipt = new Receipts('/tmp/opencode', runId);
  const observer = new Observations(client.db(`hpq1_${runId}`), new BrokerHttp(49152, 'test', 'test', new AbortController().signal),
    `hpq1_${runId}`, new OwnedDocker(new Commands('/tmp/opencode', receipt), receipt), id, new AbortController().signal);
  try {
    expect(await observer.checkpoint()).toMatchObject({ kind: 'boundary' });
    expect(find).toHaveBeenCalledWith({ _id: publisherCheckpointKey }, { readConcern: { level: 'majority' }, readPreference: 'primary' });
    expect(publisherStateCollection).toBe('tw_dispatcher_state');
  } finally { jest.restoreAllMocks(); await client.close(); }
});

test('publisher text classification is a closed exact-line allowlist,never raw fatal/URI/payload capture', () => {
  const raw = 'Dispatcher started; externally fenced single owner required\nDispatcher fatal: Rabbit connection/setup failed\nDispatcher fatal: amqp://secret-canary\nMissing --mongodb-uri\n';
  expect(publisherLogFacts(raw)).toEqual(['started_not_cursor_ready', 'fatal_rabbit_setup', 'missing_mongodb_uri']);
  expect(sanitizedLogs(raw)).not.toContain('secret-canary');
});

test.each(['boundary', 'mandatory_return'] as const)('failed %s wait persists phase/nativecheckpoint/processfacts and named deadline without changing budget', async (phase) => {
  const root = await mkdtemp('/tmp/opencode/hpq1-publisher-phase-'); const client = new MongoClient('mongodb://127.0.0.1:1');
  const controller = new AbortController(); const receipt = new Receipts(root, runId);
  const executor: Executor = async () => ({ code: 0, signal: null, stderr: '', stdout: JSON.stringify([{ Id: id,
    Config: { Labels: { 'redemeine.issue': 'redemeine-hpq1.1', 'redemeine.run': runId }, Env: ['secret-canary'] },
    State: { Running: true, ExitCode: 0, Error: 'secret-canary' } }]) });
  receipt.resources.push({ kind: 'container', name: `hpq1-${runId}-producer`, id, removed: false });
  const docker = new OwnedDocker(new Commands(root, receipt, executor), receipt); const db = client.db(`hpq1_${runId}`);
  const observer = new Observations(db, new BrokerHttp(49152, 'test', 'test', controller.signal), `hpq1_${runId}`, docker, id, controller.signal);
  jest.spyOn(Collection.prototype, 'findOne').mockResolvedValue(null);
  const stack = { docker, receipt, observer, producer: id, signal: controller.signal };
  try {
    await expect(producerWait(stack, phase, async () => { throw new QualificationError('qualification_condition_deadline'); }))
      .rejects.toThrow(`producer_${phase}_deadline`);
    expect(receipt.provenance.producerScenario).toMatchObject({ phase: `failed_${phase}`, checkpoint: { status: 'absent' }, running: true, exitCode: 0 });
    expect(await readFile(join(root, 'receipt.json'), 'utf8')).not.toContain('secret-canary');
  } finally { jest.restoreAllMocks(); await client.close(); await rm(root, { recursive: true, force: true }); }
});
