import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { RABBIT_IMAGE } from './topology-runner-core.mjs';
import { OWNER_LABEL } from './topology-runner-ownership.mjs';
import { topologyRabbitRunArgs } from './topology-real-run-args.mjs';
import ports from './topology-owned-ports.cjs';

const runId = 'topology-0123456789abcdef0123456789abcdef';
const names = { container: runId, network: `${runId}-net`, volume: `${runId}-data` };

test('pinned Rabbit run is nonroot immediately before image with same owned persistent volume', () => {
  const args = topologyRabbitRunArgs(names, runId);
  assert.deepEqual(args, ['run', '-d', '--name', names.container, '--label', `${OWNER_LABEL}=${runId}`, '--network', names.network,
    '--mount', `source=${names.volume},target=/var/lib/rabbitmq`,
    '-e', 'RABBITMQ_DEFAULT_USER=topology_owner', '-e', 'RABBITMQ_DEFAULT_PASS=topology_owner_password',
    '-p', '127.0.0.1::5672', '-p', '127.0.0.1::15672', '--user', '100:101', RABBIT_IMAGE]);
  assert.equal(args.at(-3), '--user');
  assert.equal(args.at(-2), '100:101');
  assert.equal(args.at(-1), RABBIT_IMAGE);
  assert.ok(!args.some((item) => /RABBITMQ_ERLANG_COOKIE|chmod|chown|cookie-prep/.test(item)));
});

test('active runner never invokes privileged cookie prep; readiness precedes Jest and owned cleanup remains', () => {
  const runner = readFileSync(new URL('./run-topology-real.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(runner, /cookiePrep|prepareCookie|cleanupCookieHelper|chown|chmod|ERLANG_COOKIE/);
  assert.match(runner, /preflightOwned\(docker, ownership\)/);
  assert.match(runner, /createOwned\(docker, ownership, 'container', topologyRabbitRunArgs\(names, runId\)\)/);
  assert.ok(runner.indexOf('await waitForRabbit(') < runner.indexOf('await tests(receipt, service)'));
  assert.match(runner, /receipt.cleanup = await cleanupOwned\(docker, ownership\)/);
  assert.match(runner, /finalizeAuditReceipt\(receipt, runner, receiptPath\)/);
});

test('fyp3.5.1 runner selects the owned eight-scenario suite, including retry', () => {
  const runner = readFileSync(new URL('./run-topology-real.mjs', import.meta.url), 'utf8');
  const integration = readFileSync(new URL('../integration/topology-real.integration.test.ts', import.meta.url), 'utf8');
  const producer = readFileSync(new URL('../integration/productionTopologyAudit.ts', import.meta.url), 'utf8');
  assert.match(runner, /--runTestsByPath', 'packages\/saga-worker-rabbitmq\/integration\/topology-real\.integration\.test\.ts'/);
  assert.match(runner, /receipt\.counts\.total !== 8/);
  assert.match(runner, /issue: 'redemeine-fyp3\.5\.1'/);
  assert.equal((integration.match(/\bit\('/g) ?? []).length + 3 * (integration.match(/\bit\.each\(/g) ?? []).length, 8);
  assert.match(integration, /createSagaCommitQueueTopology\(/);
  assert.match(producer, /production-kept/);
  assert.match(producer, /import \{ CommitPublisher, type RabbitConfig \} from 'tapeworm_dispatcher_mdb_rmq'/);
  assert.match(producer, /new CommitPublisher\(rabbit, 'tenant-a'\)/);
  assert.match(producer, /phaseStep\('production-publisher-publish', 'publisher-confirmed', \(\) => publisher\.publish\(commit, 'tw_source_commits'\)\)/);
  assert.match(producer, /collection: 'tw_source_commits', partitionId: 'p1', streamId: commit\.streamId, tenant: 'tenant-a'/);
  assert.match(integration, /production-wrong-collection/);
  assert.match(integration, /production-wrong-tenant/);
  const restored = integration.slice(integration.indexOf('async function inspectProductionAfterRestart('));
  assert.ok(restored.indexOf('inspectPersistedProductionTopology(management') < restored.indexOf("phaseStep('production-reprovision'"));
  assert.ok(restored.indexOf('inspectPublisherDelivery(second.channel') < restored.indexOf("phaseStep('production-reprovision'"));
  assert.ok(restored.indexOf('await waitForCounts(restored.worker.queue.queue, 1, 0)') <
    restored.indexOf('inspectPersistedProductionTopology(management'));
  assert.match(integration, /await waitForCounts\(restored\.worker\.queue\.queue, 1, 0\)/);
});

test('real restart targets same owned container; no second volume or cookie writer', () => {
  const integration = readFileSync(new URL('../integration/topology-real.integration.test.ts', import.meta.url), 'utf8');
  assert.match(integration, /spawnSync\('docker', \['restart', container\]/);
  assert.doesNotMatch(integration, /deleteVolume|volume rm|RABBITMQ_ERLANG_COOKIE|chown|chmod/);
});

test('the owned restart port reader rejects foreign identities and ambiguous mappings', () => {
  const id = 'a'.repeat(64);
  const inspection = JSON.stringify({ Id: id, Name: `/${runId}`, Config: { Labels: { [OWNER_LABEL]: runId } } });
  assert.equal(ports.ownedId(inspection, runId, id, runId), id);
  assert.throws(() => ports.ownedId(inspection, runId, 'b'.repeat(64), runId), /identity mismatch/);
  for (const mapping of ['127.0.0.1:100\n127.0.0.1:200', '0.0.0.0:100', '127.0.0.1:65536', '127.0.0.1:0']) {
    assert.throws(() => ports.mappedPort(mapping), /unique localhost Rabbit port required/);
  }
  assert.equal(ports.mappedPort('127.0.0.1:530'), 530);
  const runner = readFileSync(new URL('./run-topology-real.mjs', import.meta.url), 'utf8');
  assert.match(runner, /verified\.id !== ownership\.ids\.container/);
  assert.match(runner, /receipt\.restartPorts = \{ amqpOld: port, amqpNew: updated\.port/);
  assert.match(runner, /REDEMEINE_TOPOLOGY_CONTAINER_ID: ownership\.ids\.container/);
});
