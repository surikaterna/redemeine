import { ChildProcess, spawn, spawnSync } from 'node:child_process';
import { chmod, chown, link, mkdir, mkdtemp, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireAtRoot } from '../src/ownership';
import { flockHandshake } from '../src/flockHandshake';

const signal = () => new AbortController().signal;
const hooks = { ancestorBoundary: tmpdir() };
let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'projection-owner-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

test('actual inherited open description stays locked after helper exits; release preserves inode', async () => {
  const owner = await acquireAtRoot(root, signal(), hooks);
  const inode = (await stat(join(root, 'owner.lock'))).ino;
  await expect(acquireAtRoot(root, signal(), hooks)).rejects.toMatchObject({ exitCode: 73 });
  await owner.close();
  const next = await acquireAtRoot(root, signal(), hooks);
  expect((await stat(join(root, 'owner.lock'))).ino).toBe(inode);
  await next.close();
});

test('unrelated spawned children do not inherit the owned lock descriptor', async () => {
  const owner = await acquireAtRoot(root, signal(), hooks);
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', env: {} });
  const reaped = new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('close', () => resolve()); });
  try {
    await owner.close();
    const next = await acquireAtRoot(root, signal(), hooks);
    await next.close();
  } finally { child.kill('SIGKILL'); await reaped; }
});

test.each(['mode', 'symlink', 'hardlink', 'directory', 'owner'])('rejects untrusted lock %s', async (fault) => {
  const lock = join(root, 'owner.lock');
  if (fault === 'directory') await mkdir(lock);
  else if (fault === 'symlink') { await writeFile(join(root, 'target'), ''); await symlink('target', lock); }
  else { await writeFile(lock, '', { mode: 0o600 }); }
  if (fault === 'mode') await chmod(lock, 0o644);
  if (fault === 'hardlink') await link(lock, join(root, 'alias'));
  if (fault === 'owner') {
    if (process.getuid?.() !== 0) return;
    await chown(lock, 65534, 65534);
  }
  await expect(acquireAtRoot(root, signal(), hooks)).rejects.toMatchObject({ exitCode: 1 });
});

test('rejects insecure root and ancestor and symlink components', async () => {
  await chmod(root, 0o755);
  await expect(acquireAtRoot(root, signal(), hooks)).rejects.toMatchObject({ exitCode: 1 });
  await chmod(root, 0o700);
  const child = join(root, 'child');
  await mkdir(child, { mode: 0o700 });
  await symlink(child, join(root, 'alias'));
  await expect(acquireAtRoot(join(root, 'alias'), signal(), hooks)).rejects.toMatchObject({ exitCode: 1 });
  await chmod(root, 0o777);
  await expect(acquireAtRoot(child, signal(), hooks)).rejects.toMatchObject({ exitCode: 1 });
});

test('rejects wrong root UID when privilege permits the adversarial fixture', async () => {
  if (process.getuid?.() !== 0) return;
  await chown(root, 65534, 65534);
  await expect(acquireAtRoot(root, signal(), hooks)).rejects.toMatchObject({ exitCode: 1 });
});

test('built public serve invocation rejects a state override before admission', () => {
  const result = spawnSync(process.execPath, ['--require', join(__dirname, 'denyNetwork.cjs'), join(__dirname, '../dist/main.js')], {
    cwd: root, env: { PROJECTION_MODE: 'reference', PROJECTION_EXECUTION: 'serve', PROJECTION_STATE_DIR: root },
    encoding: 'utf8', timeout: 2000
  });
  expect(result.status).toBe(78);
  expect(result.stderr).toBe('');
  expect(result.stdout).not.toContain(root);
});

test('directory substitution during helper handshake is detected by path/handle identities', async () => {
  const original = join(root, 'state');
  await mkdir(original, { mode: 0o700 });
  const child = new ChildProcess();
  const acquisition = acquireAtRoot(original, signal(), { ...hooks, spawn: () => {
    void (async () => {
      await rename(original, join(root, 'old'));
      await mkdir(original, { mode: 0o700 });
      child.emit('close', 0, null);
    })();
    return child;
  } });
  await expect(acquisition).rejects.toMatchObject({ exitCode: 1 });
});

test.each([[0, null, 0], [73, null, 73], [2, null, 1], [0, 'SIGTERM', 1]])('helper close %s/%s gates ownership', async (code, termination, expected) => {
  const child = new ChildProcess();
  let complete = false;
  const result = flockHandshake(99, signal(), () => child).then((value) => { complete = true; return value; });
  child.emit('spawn');
  await Promise.resolve();
  expect(complete).toBe(false);
  child.emit('close', code, termination);
  expect(await result).toBe(expected);
});

test('spawn error is sanitized and reaped; abort wins over late success', async () => {
  const failed = new ChildProcess();
  const denied = flockHandshake(99, signal(), () => failed);
  failed.emit('error', new Error('secret-canary'));
  failed.emit('close', 0, null);
  expect(await denied).toBe(1);
  const abort = new AbortController();
  const child = new ChildProcess();
  jest.spyOn(child, 'kill').mockReturnValue(true);
  const result = flockHandshake(99, abort.signal, () => child);
  abort.abort();
  child.emit('close', 0, null);
  expect(await result).toBe(1);
  expect(child.kill).toHaveBeenCalledWith('SIGKILL');
});

test('helper exec failure is denied without raw stderr', async () => {
  expect(await flockHandshake(99, signal(), () => spawn('/does-not-exist', [], { stdio: 'ignore' }))).toBe(1);
});
