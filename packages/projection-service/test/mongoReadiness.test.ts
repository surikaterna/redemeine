import { createHash } from 'node:crypto';
import { initializeMongoReplica, replicationOptionsReady, replicationOptionsScript,
  initializeReplicaScript, primaryReadinessScript, type MongoScriptExecutor } from '../integration/mongoReadiness';

const actualProbeStdout = '{"oplogSizeMB":64,"replSet":"rs0"}\n';

test('actual hash-supported Mongo probe advances the same runner scripts to replica initiation then writable-primary verification', async () => {
  expect(createHash('sha256').update(actualProbeStdout).digest('hex'))
    .toBe('63a01939d93b341f35586b4ef49c22a67afb4d3855000714c12f2cb78847b697');
  expect(replicationOptionsScript).toBe('print(JSON.stringify(db.adminCommand({getCmdLineOpts:1}).parsed.replication));');
  const calls: string[] = [];
  const exec: MongoScriptExecutor = async (script) => {
    calls.push(script);
    if (script === replicationOptionsScript) return actualProbeStdout;
    if (script === initializeReplicaScript) return '';
    if (script === primaryReadinessScript) return '{"isWritablePrimary":true}\n';
    throw new Error('unexpected_mongosh_script');
  };
  await initializeMongoReplica(exec, new AbortController().signal);
  expect(calls).toEqual([replicationOptionsScript, initializeReplicaScript, primaryReadinessScript]);
});

test.each(['{}', '{"replSetName":"rs0","oplogSizeMB":64}', '{"replSet":"other","oplogSizeMB":64}',
  '{"replSet":"rs0"}', '{"replSet":"rs0","oplogSizeMB":32}', '{"replSet":"rs0","oplogSizeMB":"64"}',
  '{"replSet":64,"oplogSizeMB":64}', '{"replSet":null,"oplogSizeMB":64}', 'null', '[]', '"rs0"', '64', 'true', 'invalid JSON'])
('unexpected replication response never admits replica initialization: %s', async (stdout) => {
  expect(replicationOptionsReady(stdout)).toBe(false);
  const calls: string[] = []; const controller = new AbortController(); controller.abort();
  await expect(initializeMongoReplica(async (script) => { calls.push(script); return stdout; }, controller.signal))
    .rejects.toThrow('qualification_condition_deadline');
  expect(calls).toEqual([replicationOptionsScript]);
});

test('failed replica-init command does not proceed to primary-readiness verification', async () => {
  const calls: string[] = [];
  await expect(initializeMongoReplica(async (script) => {
    calls.push(script); if (script === replicationOptionsScript) return actualProbeStdout;
    throw new Error('mongosh_init_failed');
  }, new AbortController().signal)).rejects.toThrow('mongosh_init_failed');
  expect(calls).toEqual([replicationOptionsScript, initializeReplicaScript]);
});
