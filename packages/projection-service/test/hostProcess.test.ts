import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { until } from './support/deferred';
import { request } from './support/http';
import { modelStart } from '../src/reference/modelIdentity';

interface Running {
  child: ChildProcessWithoutNullStreams;
  output: string;
  error: string;
  closed: boolean;
  done: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}
let root: string;
let children: Running[];
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'projection-host-process-')); children = []; });
afterEach(async () => {
  for (const running of children) if (!running.closed) running.child.kill('SIGKILL');
  await Promise.all(children.map((running) => running.done));
  await rm(root, { recursive: true, force: true });
});

function launch(scenario: string): Running {
  const child = spawn(process.execPath, [join(__dirname, '.built/processHost.js'), root, scenario], {
    cwd: root, env: {}, stdio: ['pipe', 'pipe', 'pipe'] });
  const running: Running = { child, output: '', error: '', closed: false,
    done: new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => { running.closed = true; resolve({ code, signal }); });
    }) };
  child.stdout.on('data', (data) => { running.output += data.toString(); });
  child.stderr.on('data', (data) => { running.error += data.toString(); });
  children.push(running);
  return running;
}

test('OS process lock survives helper exit, contends73, SIGKILL releases without deleting inode', async () => {
  const holder = launch('lock');
  await until(() => holder.output.includes('locked'));
  const inode = (await stat(join(root, 'owner.lock'))).ino;
  expect(await launch('lock').done).toEqual({ code: 73, signal: null });
  holder.child.kill('SIGKILL');
  expect(await holder.done).toEqual({ code: null, signal: 'SIGKILL' });
  const next = launch('lock');
  await until(() => next.output.includes('locked'));
  expect((await stat(join(root, 'owner.lock'))).ino).toBe(inode);
  next.child.kill('SIGTERM');
  expect(await next.done).toEqual({ code: 0, signal: null });
});

test('compiled reference service gracefully handles signals and releases ownership only after stopping', async () => {
  const host = launch('reference');
  await until(() => host.output.includes('reference_active'));
  expect(await launch('lock').done).toEqual({ code: 73, signal: null });
  host.child.kill('SIGTERM');
  expect(await host.done).toEqual({ code: 0, signal: null });
  expect(host.error).toBe('');
  expect(host.output).toContain('"phase":"stopped"');
  expect(host.output).not.toContain('"productionReady":true');
  const next = launch('lock');
  await until(() => next.output.includes('locked'));
  next.child.kill('SIGTERM');
  await next.done;
});

test.each(['connect', 'start', 'live', 'recovery', 'close', 'channel-close'])('blocked %s reaches single deadline124; contender refused until actual death', async (scenario) => {
  const host = launch(scenario);
  const marker = scenario === 'live' || scenario === 'recovery' ? `blocked:${scenario}`
    : scenario.endsWith('close') ? 'reference_active' : 'connecting';
  await until(() => host.output.includes(marker));
  const inode = (await stat(join(root, 'owner.lock'))).ino;
  const contender = launch('contender');
  await until(() => contender.output.includes('contender-ready'));
  host.child.kill('SIGTERM');
  const signals = setInterval(() => { if (!host.closed) host.child.kill('SIGINT'); }, 60);
  try {
    await until(() => host.output.includes('"reason":"shutdown"'));
    contender.child.stdin.end('contend');
    expect(await contender.done).toEqual({ code: 73, signal: null });
    expect(await host.done).toEqual({ code: 124, signal: null });
  } finally { clearInterval(signals); }
  expect(host.error).toBe('');
  expect(host.output).not.toContain('"phase":"stopped"');
  const next = launch('lock');
  await until(() => next.output.includes('locked'));
  expect((await stat(join(root, 'owner.lock'))).ino).toBe(inode);
  next.child.kill('SIGTERM');
  await next.done;
});

test('one-shot contender reports successful acquisition after holder death instead of idling indefinitely', async () => {
  const holder = launch('lock');
  await until(() => holder.output.includes('locked'));
  const contender = launch('contender');
  await until(() => contender.output.includes('contender-ready'));
  holder.child.kill('SIGKILL');
  await holder.done;
  contender.child.stdin.end('contend');
  expect(await contender.done).toEqual({ code: 0, signal: null });
});

test('compiled poison failure is latched with sanitized observations', async () => {
  const host = launch('poison');
  await until(() => host.output.includes('startup_refused'));
  expect(host.output + host.error).not.toContain('secret-canary');
  expect(host.error).toBe('');
  host.child.kill('SIGTERM');
  expect(await host.done).toEqual({ code: 0, signal: null });
});

test('compiled external host ignores forged start JSON and remains paused503 under actual OS ownership', async () => {
  await writeFile(join(root, 'live-start.json'), JSON.stringify({ ...modelStart('a'.repeat(64)), trusted: true,
    nativeStartRef: 'native:sealed-looking', secret: 'secret-canary' }), { mode: 0o600 });
  const host = launch('external');
  await until(() => host.output.includes('startup_refused'));
  const line = host.output.split('\n').find((item) => item.includes('startup_refused'));
  if (!line) throw new Error('missing_pause');
  const snapshot = JSON.parse(line);
  expect((await request(snapshot.healthPort, '/live')).status).toBe(200);
  expect((await request(snapshot.healthPort, '/ready')).status).toBe(503);
  expect((await request(snapshot.healthPort, '/reference-ready')).status).toBe(503);
  expect(snapshot).toMatchObject({ phase: 'paused', referenceOnly: false, processedCommits: 0 });
  expect(host.output + host.error).not.toContain('secret-canary');
  expect(await launch('lock').done).toEqual({ code: 73, signal: null });
  host.child.kill('SIGTERM');
  expect(await host.done).toEqual({ code: 0, signal: null }); expect(host.error).toBe('');
});
