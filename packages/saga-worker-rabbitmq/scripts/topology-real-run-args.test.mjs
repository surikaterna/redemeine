import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { RABBIT_IMAGE } from './topology-runner-core.mjs';
import { OWNER_LABEL } from './topology-runner-ownership.mjs';
import { topologyRabbitRunArgs } from './topology-real-run-args.mjs';

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

test('real restart targets same owned container; no second volume or cookie writer', () => {
  const integration = readFileSync(new URL('../integration/topology-real.integration.test.ts', import.meta.url), 'utf8');
  assert.match(integration, /spawnSync\('docker', \['restart', container\]/);
  assert.doesNotMatch(integration, /deleteVolume|volume rm|RABBITMQ_ERLANG_COOKIE|chown|chmod/);
});
