import { mkdtemp, rm } from 'node:fs/promises';
import { Commands, type CommandResult, type Executor } from '../integration/commands';
import { OwnedDocker } from '../integration/docker';
import { Receipts, type ResourceObservation } from '../integration/receipts';
import { resourceName } from '../integration/plan';
import { deferred } from './support/deferred';

const runId = '0123456789ab'; const id = 'a'.repeat(64);
const labels = { 'redemeine.issue': 'redemeine-hpq1.1', 'redemeine.run': runId };
async function flush(): Promise<void> { for (let tick = 0; tick < 30; tick += 1) await Promise.resolve(); }

function object(kind: ResourceObservation['kind'], name: string, foreign = false) {
  const owned = { ...labels, 'redemeine.run': foreign ? 'foreign' : runId };
  if (kind === 'container') return { Id: id, Config: { Labels: owned }, State: { Running: false, ExitCode: 0 } };
  return kind === 'volume' ? { Name: name, Labels: owned } : { ID: id, Labels: owned };
}

test.each(['network', 'volume', 'container'] as const)('uncertain %s creation stays unproven across missing inspect and later exact owned removal', async (kind) => {
  const root = await mkdtemp('/tmp/opencode/hpq1-create-test-'); const controller = new AbortController();
  const pending = deferred<CommandResult>(); let visible = false; const calls: string[][] = [];
  const name = resourceName(runId, kind);
  const executor: Executor = async (_binary, args) => {
    calls.push([...args]);
    if (args[1] === 'create') return pending.promise;
    if (args[1] === 'inspect') return { code: visible ? 0 : 1, signal: null,
      stdout: visible ? JSON.stringify([object(kind, name)]) : '', stderr: visible ? '' : 'No such resource' };
    return { code: 0, signal: null, stdout: '', stderr: '' };
  };
  try {
    const receipt = new Receipts(root, runId); const resource: ResourceObservation = { kind, name, removed: false, creation: 'not_requested' };
    receipt.resources.push(resource); const commands = new Commands(root, receipt, executor); const docker = new OwnedDocker(commands, receipt);
    const creating = commands.docker(`create_${kind}`, [kind, 'create', name], controller.signal, 1000, false, resource).catch(() => {});
    await flush(); expect(resource.creation).toBe('in_flight'); controller.abort(); await creating;
    await docker.cleanup(new AbortController().signal);
    expect(resource.removed).toBe(false); expect(resource.creation).toBe('uncertain');
    expect(receipt.cleanupFailures).toContain('resource_creation_completion_unproven');
    visible = true; pending.resolve({ code: 0, signal: null, stdout: kind === 'volume' ? name : id, stderr: '' }); await flush();
    await docker.cleanup(new AbortController().signal);
    expect(resource.removalObserved).toBe(true); expect(resource.removed).toBe(false);
    expect(calls.filter((args) => args[1] === 'rm').at(-1)).toEqual([kind, 'rm', kind === 'volume' ? name : id]);
    expect(resource.lateCompletionObserved).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('late foreign resource is never removed by uncertainty reconciliation', async () => {
  const root = await mkdtemp('/tmp/opencode/hpq1-foreign-test-'); const calls: string[][] = []; const name = resourceName(runId, 'volume');
  const executor: Executor = async (_binary, args) => {
    calls.push([...args]); return { code: 0, signal: null, stderr: '', stdout: JSON.stringify([object('volume', name, true)]) };
  };
  try {
    const receipt = new Receipts(root, runId);
    receipt.resources.push({ kind: 'volume', name, removed: false, creation: 'uncertain' });
    await new OwnedDocker(new Commands(root, receipt, executor), receipt).cleanup(new AbortController().signal);
    expect(calls.some((args) => args[1] === 'rm')).toBe(false);
    expect(receipt.resources[0]?.removed).toBe(false); expect(receipt.cleanupFailures).toContain('resource_owner_mismatch');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('cleanup fence wins late reserve inspection and no subsequent create/start can be issued', async () => {
  const root = await mkdtemp('/tmp/opencode/hpq1-fence-test-'); const inspected = deferred<CommandResult>(); const calls: string[][] = [];
  const executor: Executor = async (_binary, args) => { calls.push([...args]); return inspected.promise; };
  try {
    const receipt = new Receipts(root, runId); const commands = new Commands(root, receipt, executor); const docker = new OwnedDocker(commands, receipt);
    const network = docker.network(new AbortController().signal).catch((error: unknown) => error);
    await flush(); commands.beginCleanup(); inspected.resolve({ code: 1, signal: null, stdout: '', stderr: 'No such network' });
    expect(await network).toBeInstanceOf(Error); expect(receipt.resources).toHaveLength(0);
    await expect(commands.docker('start_owned_container', ['container', 'start', id], new AbortController().signal)).rejects.toThrow('runner_admission_fenced');
    await expect(commands.docker('inspect_container', ['container', 'create', 'late'], new AbortController().signal)).rejects.toThrow('runner_admission_fenced');
    commands.closeFence(); commands.beginCleanup();
    await expect(commands.docker('inspect_container', ['container', 'inspect', id], new AbortController().signal)).rejects.toThrow('runner_admission_fenced');
    expect(calls).toHaveLength(1); expect(calls[0]?.[1]).toBe('inspect');
  } finally { await rm(root, { recursive: true, force: true }); }
});
