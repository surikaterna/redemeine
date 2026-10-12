import { budgets, issueId, resourceName, QualificationError, qualificationNetwork } from './plan';
import { assert, integer, one, record, string } from './schema';
import { Commands } from './commands';
import type { Receipts, ResourceObservation } from './receipts';
import { portObservation, verifiedLoopbackPort } from './portDiagnostics';
import { type Role, rolePorts, verifyBridge, verifyNetworkMode, verifyAttachment, verifyDeclaredPorts, verifyActivePorts, validPortSpec } from './networkPolicy';

export type { Role } from './networkPolicy';
const limits = { mongo: [1073741824, 1], rabbit: [1073741824, 1], producer: [536870912, 0.5],
  projection: [536870912, 0.5], 'key-init': [134217728, 0.5] };
const roles: readonly Role[] = ['mongo', 'rabbit', 'producer', 'projection', 'key-init'];
export interface ContainerSpec {
  role: Role; image: string; network: string; env: Readonly<Record<string, string>>;
  mounts?: readonly { volume: string; target: string; readonly?: boolean }[];
  ports?: readonly number[]; command?: readonly string[];
}

export function verifyContainerCaps(value: Record<string, unknown>, role: Role): void {
  const config = record(value.HostConfig); const [memory = 0, cpu = 0] = limits[role];
  assert(config.Memory === memory && config.MemorySwap === memory && config.NanoCpus === cpu * 1000000000
    && config.PidsLimit === 128 && config.Privileged === false, 'container_cap_mismatch');
  const logs = record(config.LogConfig);
  assert(logs.Type === 'local' && record(logs.Config)['max-size'] === '10m' && record(logs.Config)['max-file'] === '2', 'container_log_cap_mismatch');
  if (role === 'projection') assert(config.ReadonlyRootfs === true && record(value.Config).User === '10001:10001', 'projection_filesystem_identity_mismatch');
}

export function verifyOwner(value: Record<string, unknown>, resource: ResourceObservation, runId: string): void {
  const labels = record(resource.kind === 'container' || resource.kind === 'image' ? record(value.Config).Labels : value.Labels);
  assert(labels['redemeine.issue'] === issueId && labels['redemeine.run'] === runId, 'resource_owner_mismatch');
  const id = resource.kind === 'volume' ? value.Name : value.Id ?? value.ID;
  if (resource.id !== undefined) assert(id === resource.id, 'resource_identity_changed');
  if (resource.kind === 'volume') assert(value.Name === resource.name, 'resource_identity_changed');
}

export class OwnedDocker {
  constructor(readonly commands: Commands, readonly receipt: Receipts) {}

  private labels(): string[] { return ['--label', `redemeine.issue=${issueId}`, '--label', `redemeine.run=${this.receipt.runId}`]; }

  private async inspect(kind: ResourceObservation['kind'], identity: string, signal: AbortSignal, missing = false) {
    const result = await this.commands.docker(`inspect_${kind}`, [kind, 'inspect', identity], signal, budgets.commandMs, missing);
    if (result.code !== 0) {
      assert(missing && /No such|not found/i.test(result.stderr), 'resource_inspection_failed');
      return null;
    }
    const value: unknown = JSON.parse(result.stdout); return one(value);
  }

  private async reserve(kind: ResourceObservation['kind'], name: string, signal: AbortSignal): Promise<ResourceObservation> {
    this.commands.assertRunning();
    assert(this.receipt.resources.length < 16 && !this.receipt.resources.some((item) => item.name === name), 'resource_capacity_or_duplicate');
    assert(await this.inspect(kind, name, signal, true) === null, 'existing_resource_refused');
    this.commands.assertRunning();
    const resource: ResourceObservation = { kind, name, removed: false, creation: 'not_requested' };
    this.receipt.resources.push(resource); await this.receipt.save(); return resource;
  }

  private async register(resource: ResourceObservation, id: string, signal: AbortSignal): Promise<string> {
    this.commands.assertRunning();
    if (resource.kind !== 'volume') assert(/^(sha256:)?[a-f0-9]{64}$/.test(id), 'resource_id_invalid');
    const inspected = await this.inspect(resource.kind, resource.name, signal);
    this.commands.assertRunning();
    assert(inspected !== null, 'resource_inspection_failed');
    if (!inspected) throw new QualificationError('resource_inspection_failed');
    resource.id = id; verifyOwner(inspected, resource, this.receipt.runId); await this.receipt.save(); return id;
  }

  async network(signal: AbortSignal): Promise<string> {
    const resource = await this.reserve('network', resourceName(this.receipt.runId, 'network'), signal);
    const result = await this.commands.docker('create_network', ['network', 'create', '--driver', 'bridge', ...this.labels(), resource.name], signal, budgets.commandMs, false, resource);
    const id = await this.register(resource, result.stdout.trim(), signal);
    const network = await this.inspect('network', id, signal);
    if (!network) throw new QualificationError('resource_inspection_failed');
    verifyOwner(network, resource, this.receipt.runId); verifyBridge(network, id, resource.name);
    this.receipt.provenance.network = { ...qualificationNetwork, id, name: resource.name };
    return id;
  }

  async volume(role: string, signal: AbortSignal): Promise<string> {
    const resource = await this.reserve('volume', resourceName(this.receipt.runId, role), signal);
    const result = await this.commands.docker('create_volume', ['volume', 'create', ...this.labels(), resource.name], signal, budgets.commandMs, false, resource);
    return this.register(resource, result.stdout.trim(), signal);
  }

  async pull(image: string, signal: AbortSignal): Promise<{ id: string; reference: string }> {
    await this.commands.docker('pull_base_image', ['pull', image], signal, budgets.pullMs);
    const inspected = await this.inspect('image', image, signal);
    if (!inspected) throw new QualificationError('image_inspection_failed');
    const id = string(inspected.Id); assert(/^sha256:[a-f0-9]{64}$/.test(id), 'image_identity_invalid');
    const digests: unknown = inspected.RepoDigests;
    assert(Array.isArray(digests), 'image_digest_missing');
    if (!Array.isArray(digests)) throw new QualificationError('image_digest_missing');
    const repository = image.split(':')[0];
    const reference: unknown = digests.find((value: unknown) => typeof value === 'string'
      && value.split('@')[0]?.split('/').at(-1) === repository && /@sha256:[a-f0-9]{64}$/.test(value));
    const pinned = string(reference);
    this.receipt.provenance[image] = { id, reference: pinned, cleanup: 'shared_base_not_removed' };
    return { id, reference: pinned };
  }

  async unchangedBase(tag: string, expectedId: string, signal: AbortSignal): Promise<void> {
    const image = await this.inspect('image', tag, signal);
    assert(image?.Id === expectedId, 'base_image_changed_during_build');
  }

  async build(role: 'producer-image' | 'projection-image', context: string, dockerfile: string,
    args: Readonly<Record<string, string>>, signal: AbortSignal): Promise<string> {
    const tag = `${resourceName(this.receipt.runId, role)}:qualification`;
    const resource = await this.reserve('image', tag, signal);
    const argumentsList = Object.entries(args).flatMap(([key, value]) => ['--build-arg', `${key}=${value}`]);
    await this.commands.docker('build_owned_image', ['build', '--force-rm', '--memory', '2g', '--cpu-period', '100000', '--cpu-quota', '100000',
      ...this.labels(), ...argumentsList, '-f', dockerfile, '-t', tag, context], signal, budgets.buildMs, false, resource);
    const image = await this.inspect('image', tag, signal);
    if (!image) throw new QualificationError('image_inspection_failed');
    return this.register(resource, string(image.Id), signal);
  }

  async container(spec: ContainerSpec, signal: AbortSignal): Promise<string> {
    assert(/^sha256:[a-f0-9]{64}$/.test(spec.image), 'unpinned_container_image');
    assert(this.receipt.resources.some((item) => item.kind === 'network' && item.id === spec.network), 'unowned_network');
    assert(validPortSpec(spec.role, spec.ports ?? []), 'container_port_spec_mismatch');
    for (const mount of spec.mounts ?? []) {
      assert(this.receipt.resources.some((item) => item.kind === 'volume' && item.id === mount.volume), 'unowned_volume');
      assert(/^\/[a-zA-Z0-9/_-]+$/.test(mount.target), 'invalid_mount_target');
    }
    const resource = await this.reserve('container', resourceName(this.receipt.runId, spec.role), signal);
    const [memory = 0, cpu = 0] = limits[spec.role];
    const caps = spec.role === 'mongo' || spec.role === 'rabbit' ? ['CHOWN', 'SETUID', 'SETGID', 'DAC_OVERRIDE'] : spec.role === 'key-init' ? ['CHOWN'] : [];
    const args = ['container', 'create', '--name', resource.name, ...this.labels(), '--network', spec.network,
      '--memory', String(memory), '--memory-swap', String(memory), '--cpus', String(cpu), '--pids-limit', '128',
      '--security-opt', 'no-new-privileges', '--cap-drop', 'ALL', ...caps.flatMap((cap) => ['--cap-add', cap]),
      '--log-driver', 'local', '--log-opt', 'max-size=10m', '--log-opt', 'max-file=2'];
    if (spec.role !== 'key-init') args.push('--network-alias', spec.role);
    if (spec.role === 'projection') args.push('--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m');
    args.push(...Object.entries(spec.env).flatMap(([key, value]) => ['--env', `${key}=${value}`]));
    args.push(...(spec.mounts ?? []).flatMap((mount) => ['--mount', `type=volume,source=${mount.volume},target=${mount.target}${mount.readonly ? ',readonly' : ''}`]));
    args.push(...(spec.ports ?? []).flatMap((port) => ['--publish', `127.0.0.1::${port}`]));
    args.push(spec.image, ...(spec.command ?? []));
    const result = await this.commands.docker('create_owned_container', args, signal, budgets.commandMs, false, resource);
    const id = await this.register(resource, result.stdout.trim(), signal);
    const value = await this.inspect('container', id, signal);
    if (!value) throw new QualificationError('resource_inspection_failed');
    verifyContainerCaps(value, spec.role);
    const network = this.receipt.resources.find((item) => item.kind === 'network' && item.id === spec.network);
    if (!network) throw new QualificationError('unowned_network');
    verifyNetworkMode(value, spec.network, network.name); verifyDeclaredPorts(value, spec.role);
    return id;
  }

  async inspectContainer(id: string, signal: AbortSignal) {
    const resource = this.receipt.resources.find((item) => item.kind === 'container' && item.id === id);
    if (!resource) throw new QualificationError('unowned_container');
    const value = await this.inspect('container', id, signal);
    if (!value) throw new QualificationError('resource_inspection_failed');
    verifyOwner(value, resource, this.receipt.runId); return value;
  }

  async start(id: string, signal: AbortSignal): Promise<void> {
    await this.inspectContainer(id, signal); await this.commands.docker('start_owned_container', ['container', 'start', id], signal);
    const value = await this.inspectContainer(id, signal);
    this.verifyContainerNetwork(value);
    const resource = this.receipt.resources.find((item) => item.kind === 'container' && item.id === id);
    if (!resource) throw new QualificationError('unowned_container');
    const role = this.role(resource.name);
    verifyDeclaredPorts(value, role);
    const ports = rolePorts(role); const firstPort = ports[0];
    if (firstPort !== undefined) await this.port(id, firstPort, signal);
    else verifyActivePorts(value, role);
  }

  private role(name: string): Role {
    for (const role of roles) if (name === resourceName(this.receipt.runId, role)) return role;
    throw new QualificationError('container_role_unknown');
  }

  private verifyContainerNetwork(value: Record<string, unknown>): void {
    const network = this.receipt.resources.find((item) => item.kind === 'network');
    if (!network?.id) throw new QualificationError('unowned_network');
    verifyAttachment(value, network.id, network.name);
  }

  async stop(id: string, signal: AbortSignal): Promise<number> {
    const value = await this.inspectContainer(id, signal);
    if (record(value.State).Running === true) await this.commands.docker('stop_owned_container', ['container', 'stop', '--time', '12', id], signal);
    const stopped = await this.inspectContainer(id, signal);
    assert(record(stopped.State).Running === false, 'container_still_running'); return integer(record(stopped.State).ExitCode);
  }

  async port(id: string, port: number, signal: AbortSignal): Promise<number> {
    const value = await this.inspectContainer(id, signal);
    const resource = this.receipt.resources.find((item) => item.kind === 'container' && item.id === id);
    if (!resource) throw new QualificationError('unowned_container');
    const role = this.role(resource.name); const ports = rolePorts(role);
    assert(this.receipt.portObservations.length + ports.length <= 32 && ports.includes(port), 'port_diagnostic_capacity_or_scope');
    for (const requested of ports) this.receipt.portObservations.push(portObservation(id, value, requested));
    await this.receipt.save();
    this.verifyContainerNetwork(value);
    verifyDeclaredPorts(value, role); verifyActivePorts(value, role);
    return verifiedLoopbackPort(value, port);
  }

  async exec(id: string, args: readonly string[], signal: AbortSignal): Promise<string> {
    await this.inspectContainer(id, signal);
    return (await this.commands.docker('exec_owned_container', ['container', 'exec', id, ...args], signal)).stdout;
  }

  async cleanup(signal: AbortSignal): Promise<void> {
    this.commands.beginCleanup();
    const kinds = ['container', 'image', 'volume', 'network'];
    for (const kind of kinds) {
      const resources = [...this.receipt.resources].reverse().filter((item) => item.kind === kind && !item.removed);
      for (const resource of resources) await this.remove(resource, signal);
    }
  }

  private async reconcile(resource: ResourceObservation, signal: AbortSignal) {
    let value = await this.inspect(resource.kind, resource.id ?? resource.name, signal, true);
    for (let check = 1; !value && check < 3 && resource.creation === 'uncertain'; check += 1) {
      value = await this.inspect(resource.kind, resource.name, signal, true);
    }
    return value;
  }

  private async remove(resource: ResourceObservation, signal: AbortSignal): Promise<void> {
    try {
      const value = await this.reconcile(resource, signal);
      if (value) {
        verifyOwner(value, resource, this.receipt.runId);
        if (!resource.id) resource.id = resource.kind === 'volume' ? string(value.Name) : string(value.Id ?? value.ID);
        if (resource.kind === 'container') await this.stop(resource.id, signal);
        const target = resource.kind === 'image' || resource.kind === 'volume' ? resource.name : resource.id;
        await this.commands.docker('remove_owned_resource', [resource.kind, 'rm', target], signal);
        resource.removalObserved = true;
      }
      if (resource.creation === 'uncertain' || resource.creation === 'in_flight') {
        throw new QualificationError('resource_creation_completion_unproven');
      }
      if (!value && resource.kind === 'image' && this.receipt.provenance.buildDaemonCompletion === 'unproven_after_cli_failure') {
        throw new QualificationError('image_build_completion_unproven');
      }
      resource.removed = true;
    } catch (error) { this.receipt.cleanupFailures.push(error instanceof QualificationError ? error.reason : 'cleanup_failed'); }
    await this.receipt.save();
  }
}
