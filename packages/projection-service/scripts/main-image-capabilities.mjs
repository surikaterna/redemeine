import assert from 'node:assert/strict';

const imageRefusals = ['image_config_invalid', 'image_user_mismatch', 'image_entrypoint_mismatch', 'image_stop_signal_mismatch',
  'image_implicit_volume_refused', 'image_revision_label_mismatch', 'image_version_label_mismatch', 'image_healthcheck_invalid', 'image_source_plan_mismatch'];
const entrypoint = ['/usr/bin/tini', '-g', '--', 'node', '/app/main.js'];
function plainRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
function sameEntrypoint(value) { return Array.isArray(value) && value.length === entrypoint.length && value.every((part, index) => part === entrypoint[index]); }
function noDeclaration(record, key) {
  if (!Object.hasOwn(record, key)) return true;
  const value = record[key]; return value === null || (plainRecord(value) && Reflect.ownKeys(value).length === 0);
}
function declarationFacts(record, key) {
  if (!Object.hasOwn(record, key)) return { present: false, kind: 'absent', entries: 0 };
  const value = record[key]; const plain = plainRecord(value);
  return { present: true, kind: value === null ? 'null' : plain ? 'record' : Array.isArray(value) ? 'array' : 'malformed',
    entries: value === null ? 0 : plain ? Reflect.ownKeys(value).length : null };
}
export function imageValidationReason(error) { return imageRefusals.includes(error?.code) ? error.code : undefined; }

/** Shape/match facts only; never retain environment, commands, values or declaration paths. */
export function imageCapabilityFacts(image) {
  const configPresent = plainRecord(image) && Object.hasOwn(image, 'Config');
  const configPlain = configPresent && plainRecord(image.Config); const config = configPlain ? image.Config : {};
  const labelsPlain = Object.hasOwn(config, 'Labels') && plainRecord(config.Labels); const labels = labelsPlain ? config.Labels : {};
  const healthcheckPlain = Object.hasOwn(config, 'Healthcheck') && plainRecord(config.Healthcheck); const health = healthcheckPlain ? config.Healthcheck : {};
  const testStrings = Object.hasOwn(health, 'Test') && Array.isArray(health.Test) && health.Test.every((part) => typeof part === 'string');
  return { configPresent, configPlain, userMatches: Object.hasOwn(config, 'User') && config.User === '10001:10001',
    entrypointMatches: Object.hasOwn(config, 'Entrypoint') && sameEntrypoint(config.Entrypoint),
    stopSignalMatches: Object.hasOwn(config, 'StopSignal') && config.StopSignal === 'SIGTERM', volumes: declarationFacts(config, 'Volumes'), noVolumes: noDeclaration(config, 'Volumes'),
    labelsPlain, revisionMatches: Object.hasOwn(labels, 'org.opencontainers.image.revision') && labels['org.opencontainers.image.revision'] === 'uncommitted-source-snapshot',
    versionMatches: Object.hasOwn(labels, 'org.opencontainers.image.version') && labels['org.opencontainers.image.version'] === '0.1.0-rc.1', healthcheckPresent: Object.hasOwn(config, 'Healthcheck'),
    healthcheckPlain, healthcheckTestStrings: testStrings,
    healthcheckMatches: testStrings && health.Test.length > 1 && health.Test[0] === 'CMD' && health.Test.join(' ').includes('HEALTH_PORT') };
}

export function assertDaemonCapabilities(info) {
  assert.equal(info.OSType, 'linux', 'linux_daemon_required');
  for (const key of ['MemoryLimit', 'SwapLimit', 'CpuCfsQuota', 'CpuCfsPeriod', 'PidsLimit']) assert.equal(info[key], true, 'daemon_capability_unproven');
}

function assertMounts(row, container, plan) {
  const tmpfs = row.HostConfig.Tmpfs;
  assert.deepEqual(Object.keys(tmpfs), ['/tmp']);
  assert.deepEqual(tmpfs['/tmp'].split(',').sort(), ['rw', 'nosuid', 'nodev', 'noexec', 'size=16m'].sort());
  const mounts = row.Mounts; assert.ok(Array.isArray(mounts));
  const binds = mounts.filter((mount) => mount.Type === 'bind');
  assert.equal(binds.length, container.kind === 'invalid' ? 1 : 0);
  if (binds.length) {
    assert.equal(binds[0].Source, `${plan.directory}/invalid.mjs`); assert.equal(binds[0].Destination, '/app/definitions/invalid.mjs');
    assert.equal(binds[0].RW, false); assert.equal(binds[0].Propagation, 'rprivate');
  }
  const temporary = mounts.filter((mount) => mount.Type === 'tmpfs'); assert.ok(temporary.length <= 1);
  if (temporary.length) { assert.equal(temporary[0].Destination, '/tmp'); assert.equal(temporary[0].RW, true); }
  assert.equal(mounts.length, binds.length + temporary.length, 'unexpected_mount');
}

export function assertContainerCapabilities(row, container, plan, imageId) {
  assert.ok(plainRecord(row) && plainRecord(row.Config) && plainRecord(row.HostConfig), 'container_config_invalid');
  assert.equal(row.Image, imageId); assert.equal(row.Name, `/${container.name}`);
  assert.equal(row.Config.User, '10001:10001');
  assert.deepEqual(row.Config.Entrypoint, ['/usr/bin/tini', '-g', '--', 'node', '/app/main.js']);
  const config = row.HostConfig;
  assert.equal(config.Memory, 536870912); assert.equal(config.MemorySwap, 536870912);
  assert.equal(config.NanoCpus, 500000000); assert.equal(config.PidsLimit, 128);
  assert.equal(config.ReadonlyRootfs, true); assert.equal(config.Privileged, false);
  assert.deepEqual(config.CapDrop, ['ALL']); assert.ok(config.CapAdd === null || (Array.isArray(config.CapAdd) && config.CapAdd.length === 0));
  assert.ok(Array.isArray(config.SecurityOpt) && config.SecurityOpt.length === 1
    && ['no-new-privileges', 'no-new-privileges:true'].includes(config.SecurityOpt[0]));
  assert.deepEqual(config.LogConfig, { Type: 'local', Config: { 'max-size': '1m', 'max-file': '2' } });
  assert.equal(config.NetworkMode, 'none'); assert.equal(config.PublishAllPorts, false); assert.ok(noDeclaration(config, 'PortBindings'), 'container_port_bindings_refused');
  assert.ok(noDeclaration(row.Config, 'Volumes'), 'implicit_volume_refused');
  assert.ok(plainRecord(row.NetworkSettings) && plainRecord(row.NetworkSettings.Networks), 'container_network_metadata_invalid');
  assert.ok(Object.keys(row.NetworkSettings.Networks).every((key) => key === 'none'));
  assert.ok(Object.hasOwn(row.NetworkSettings, 'Ports') && (row.NetworkSettings.Ports === null || plainRecord(row.NetworkSettings.Ports)), 'container_port_metadata_unproven');
  assert.ok(Object.values(row.NetworkSettings.Ports ?? {}).every((value) => value === null || (Array.isArray(value) && value.length === 0)));
  assertMounts(row, container, plan);
}

export function assertImageCapabilities(image) {
  const facts = imageCapabilityFacts(image);
  const predicates = [facts.configPresent && facts.configPlain, facts.userMatches, facts.entrypointMatches, facts.stopSignalMatches,
    facts.noVolumes, facts.labelsPlain && facts.revisionMatches, facts.labelsPlain && facts.versionMatches,
    facts.healthcheckPlain && facts.healthcheckMatches];
  for (const [index, matches] of predicates.entries()) {
    if (!matches) throw Object.assign(new Error(imageRefusals[index]), { code: imageRefusals[index] });
  }
  return facts;
}
