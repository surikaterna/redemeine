import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { assertImageCapabilities, assertContainerCapabilities, imageCapabilityFacts, imageValidationReason } from '../../scripts/main-image-capabilities.mjs';
import { ImageResourceLedger } from '../../scripts/main-image-ledger.mjs';

const id = `sha256:${'a'.repeat(64)}`;
const plan = { image: 'main:unique', directory: '/owned', reviewDigest: 'review', build: ['build'], deadlines: { build: 10 }, labels: { issue: 'hpq1.2', run: 'unique', source: 'freeze' },
  containers: [{ kind: 'missing', name: 'missing' }, { kind: 'invalid', name: 'invalid' }] };
function image() {
  return { Id: id, RepoTags: [plan.image], Config: { User: '10001:10001', Entrypoint: ['/usr/bin/tini', '-g', '--', 'node', '/app/main.js'], StopSignal: 'SIGTERM',
    Labels: { ...plan.labels, 'org.opencontainers.image.revision': 'uncommitted-source-snapshot', 'org.opencontainers.image.version': '0.1.0-rc.1', private: 'secret-label' },
    Healthcheck: { Test: ['CMD', 'node', 'HEALTH_PORT'] }, Env: ['PASSWORD=secret-env'], Cmd: ['private://secret-command'] } };
}
function container() {
  return { Image: id, Name: '/missing', Config: { User: '10001:10001', Entrypoint: ['/usr/bin/tini', '-g', '--', 'node', '/app/main.js'] },
    HostConfig: { Memory: 536870912, MemorySwap: 536870912, NanoCpus: 500000000, PidsLimit: 128, ReadonlyRootfs: true, Privileged: false,
      CapDrop: ['ALL'], CapAdd: null, SecurityOpt: ['no-new-privileges'], LogConfig: { Type: 'local', Config: { 'max-size': '1m', 'max-file': '2' } },
      NetworkMode: 'none', PublishAllPorts: false, Tmpfs: { '/tmp': 'rw,nosuid,nodev,noexec,size=16m' } },
    NetworkSettings: { Networks: { none: {} }, Ports: { '9464/tcp': null } }, Mounts: [] };
}
test('native JSON omitted/null/empty-record Volumes passes only valid required image metadata', () => {
  assertImageCapabilities(JSON.parse(JSON.stringify(image())));
  for (const value of [null, {}, Object.create(null)]) { const row = image(); row.Config.Volumes = value; assertImageCapabilities(row); }
  const inherited = image(); inherited.Config = Object.create({ User: '10001:10001' });
  assert.throws(() => assertImageCapabilities(inherited), (error) => error.code === 'image_config_invalid');
});
test('present undefined/array/nonplain/nonempty Volumes refuses with a safe field-specific code', () => {
  for (const value of [undefined, [], new Date(), false, { '/private/secret-volume': {} }]) {
    const row = image(); row.Config.Volumes = value;
    assert.throws(() => assertImageCapabilities(row), (error) => error.code === 'image_implicit_volume_refused' && !error.message.includes('secret'));
  }
});
test('missing/malformed required image fields retain strict refusal and healthcheck shape', () => {
  const cases = [['User', 'image_user_mismatch'], ['Entrypoint', 'image_entrypoint_mismatch'], ['StopSignal', 'image_stop_signal_mismatch'],
    ['Labels', 'image_revision_label_mismatch'], ['Healthcheck', 'image_healthcheck_invalid']];
  for (const [field, code] of cases) { const row = image(); delete row.Config[field]; assert.throws(() => assertImageCapabilities(row), (error) => error.code === code); }
  for (const config of [undefined, null, [], 'secret']) assert.throws(() => assertImageCapabilities({ Config: config }), (error) => error.code === 'image_config_invalid');
  for (const test of ['HEALTH_PORT', ['CMD', 5, 'HEALTH_PORT'], ['NONE'], ['CMD', 'no-token']]) {
    const row = image(); row.Config.Healthcheck.Test = test; assert.throws(() => assertImageCapabilities(row), (error) => error.code === 'image_healthcheck_invalid');
  }
  const version = image(); version.Config.Labels['org.opencontainers.image.version'] = 'private-version';
  assert.throws(() => assertImageCapabilities(version), (error) => error.code === 'image_version_label_mismatch');
});
test('optional PortBindings omission/null/empty-map preserves effective-network/port and all required caps', () => {
  assertContainerCapabilities(JSON.parse(JSON.stringify(container())), plan.containers[0], plan, id);
  for (const value of [null, {}]) { const row = container(); row.HostConfig.PortBindings = value; assertContainerCapabilities(row, plan.containers[0], plan, id); }
  for (const value of [undefined, [], { '9464/tcp': [] }]) {
    const row = container(); row.HostConfig.PortBindings = value; assert.throws(() => assertContainerCapabilities(row, plan.containers[0], plan, id));
  }
  for (const key of ['Memory', 'NanoCpus', 'PidsLimit', 'ReadonlyRootfs', 'Privileged', 'SecurityOpt']) {
    const row = container(); delete row.HostConfig[key]; assert.throws(() => assertContainerCapabilities(row, plan.containers[0], plan, id));
  }
  const effective = container(); effective.NetworkSettings.Ports['9464/tcp'] = [{ HostPort: '9464' }];
  assert.throws(() => assertContainerCapabilities(effective, plan.containers[0], plan, id));
  for (const value of [undefined, []]) { const row = container(); row.NetworkSettings.Ports = value; assert.throws(() => assertContainerCapabilities(row, plan.containers[0], plan, id)); }
  const missing = container(); delete missing.NetworkSettings.Ports; assert.throws(() => assertContainerCapabilities(missing, plan.containers[0], plan, id));
});
test('omitted declaration cannot hide actual volume mounts or extra networks', () => {
  const row = container(); row.Mounts.push({ Type: 'volume', Destination: '/state' });
  assert.throws(() => assertContainerCapabilities(row, plan.containers[0], plan, id));
  const network = container(); network.NetworkSettings.Networks.bridge = {};
  assert.throws(() => assertContainerCapabilities(network, plan.containers[0], plan, id));
});
test('actual build caller records only owned-ID predicate/shape facts and closed refusal code', async () => {
  const source = await readFile(new URL('../../scripts/check-main-image.mjs', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('async function build('), source.indexOf('async function execute('));
  const row = image(); row.Config.User = 'private://secret-user'; row.Config.Volumes = { '/secret-volume': {} };
  const receipt = {}; const ledger = new ImageResourceLedger(plan); await ledger.preflight(async () => null);
  const build = new Function('required', 'inspect', 'imagePlan', 'run', 'receipt', 'assertImageCapabilities', 'imageCapabilityFacts',
    `${body};return build;`)(async () => Buffer.alloc(0), async () => row, async () => plan, 'unique', receipt, assertImageCapabilities, imageCapabilityFacts);
  await assert.rejects(build(plan, ledger), (error) => imageValidationReason(error) === 'image_user_mismatch');
  assert.deepEqual(receipt.imageValidation.facts.volumes, { present: true, kind: 'record', entries: 1 });
  assert.equal(receipt.imageValidation.id, id); assert.equal(receipt.imageValidation.sourcePlanMatches, true);
  assert.doesNotMatch(JSON.stringify(receipt), /secret|PASSWORD|private:\/\/|Env|Cmd/);
  assert.equal(imageValidationReason({ code: 'secret-code' }), undefined);
  assert.equal(imageCapabilityFacts(image()).volumes.kind, 'absent');
  const changedReceipt = {}; const nextLedger = new ImageResourceLedger(plan); await nextLedger.preflight(async () => null);
  const changed = new Function('required', 'inspect', 'imagePlan', 'run', 'receipt', 'assertImageCapabilities', 'imageCapabilityFacts',
    `${body};return build;`)(async () => Buffer.alloc(0), async () => image(), async () => ({ reviewDigest: 'changed' }), 'unique', changedReceipt, assertImageCapabilities, imageCapabilityFacts);
  await assert.rejects(changed(plan, nextLedger), (error) => imageValidationReason(error) === 'image_source_plan_mismatch');
  assert.equal(changedReceipt.imageValidation.sourcePlanMatches, false);
});
