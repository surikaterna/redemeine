import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, readlink, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { relative, resolve, sep } from 'node:path';
import semver from 'semver';
import { z } from 'zod';

export const hash = (bytes, algorithm = 'sha256') => createHash(algorithm).update(bytes).digest('hex');
export const sri = (bytes) => `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
export const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
export const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const policySchema = z
  .object({
    schemaVersion: z.literal(1),
    registry: z.literal('https://registry.npmjs.org/'),
    internalScopes: z.array(z.string().regex(/^@[a-z0-9-]+$/)),
    holds: z.record(z.string(), z.object({ owner: z.string().min(1), reason: z.string().min(1) }).strict()),
    knownBad: z.record(z.string(), z.array(z.string().refine((v) => semver.valid(v) === v)))
  })
  .strict();

export function diagnostic(report, code, message, context = {}, incomplete = false) {
  report.diagnostics.push({ code, message, severity: incomplete ? 'incomplete' : 'error', ...context });
}

export function run(report, cwd, command, args) {
  const pnpm = command === 'pnpm';
  if (pnpm) args = [...args, '--config.ignore-pnpmfile=true', '--config.ignore-scripts=true'];
  const env = pnpm ? pnpmEnvironment() : process.env;
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
  report.invocations.push({
    cwd: relative(report.root, cwd) || '.',
    command,
    args,
    exit: result.status,
    ignoreScripts: args.includes('--config.ignore-scripts=true'),
    ignorePnpmfile: pnpm,
    enforcedEnvironment: pnpm ? pnpmSafetyEnvironment : undefined
  });
  if (result.error || result.status !== 0)
    throw new Error(`${command} ${args.join(' ')} failed (${result.status}): ${result.error?.message || result.stderr || result.stdout}`);
  return result.stdout.trim();
}

const pnpmSafetyEnvironment = {
  pnpm_config_ignore_pnpmfile: 'true',
  pnpm_config_ignore_scripts: 'true',
  npm_config_ignore_pnpmfile: 'true',
  npm_config_ignore_scripts: 'true'
};

function pnpmEnvironment() {
  // pnpm 11.9 loads config even for --version; CLI flags alone do not defeat workspace settings there.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^p?npm_config_ignore[_-]?(pnpmfile|scripts)$/i.test(key)));
  return { ...env, ...pnpmSafetyEnvironment };
}

export async function prerequisites(root, report) {
  const manifest = await json(resolve(root, 'package.json'));
  const pin = /^pnpm@(\d+\.\d+\.\d+)(?:\+sha512\.[a-f0-9]+)?$/.exec(manifest.packageManager);
  if (process.versions.node.split('.')[0] !== '24' || !pin) throw new Error('Requires Node 24 and an exact root packageManager pnpm pin');
  const pnpm = run(report, root, 'pnpm', ['--version']);
  if (pnpm !== pin[1]) throw new Error(`pnpm version ${pnpm} differs from ${pin[1]}`);
  const require = createRequire(import.meta.url);
  const helpers = Object.fromEntries(
    ['semver', 'tar', 'npm-package-arg', 'ssri', 'minimatch', 'zod', '@changesets/cli', 'typescript', 'tsup', 'turbo'].map((name) => [
      name,
      require(`${name}/package.json`).version
    ])
  );
  report.tools = { node: process.version, pnpm, npm: run(report, root, 'npm', ['--version']), packageManager: manifest.packageManager, helpers };
  report.inputs = {};
  for (const file of ['pnpm-lock.yaml', 'pnpm-workspace.yaml', 'scripts/release/policy.json']) {
    report.inputs[file] = hash(await readFile(resolve(root, file)));
  }
  return policySchema.parse(await json(resolve(root, 'scripts/release/policy.json')));
}

export async function sourceIdentity(root, report) {
  const sha = run(report, root, 'git', ['rev-parse', 'HEAD']);
  const diff = run(report, root, 'git', ['diff', '--binary', 'HEAD']);
  const status = run(report, root, 'git', ['status', '--porcelain', '--untracked-files=all']);
  const names = run(report, root, 'git', ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean).sort();
  const untracked = [];
  for (const name of names) {
    const path = resolve(root, name);
    const stat = await lstat(path);
    untracked.push({
      path: name,
      type: stat.isSymbolicLink() ? 'symlink' : 'file',
      sha256: hash(stat.isSymbolicLink() ? await readlink(path) : await readFile(path))
    });
  }
  return { sha, dirty: Boolean(status), diffSha256: hash(diff), untracked, snapshotIdentity: hash(JSON.stringify({ sha, diff, untracked })) };
}

export async function discover(root, policy, report) {
  const listed = JSON.parse(run(report, root, 'pnpm', ['list', '--recursive', '--depth', '-1', '--json']));
  if (!Array.isArray(listed) || !listed.length) throw new Error('Invalid pnpm workspace inventory');
  const names = new Set();
  const paths = new Set();
  const packages = [];
  for (const item of listed) {
    if (!object(item) || typeof item.path !== 'string') throw new Error('Invalid workspace entry');
    const path = await realpath(item.path);
    const rel = relative(root, path);
    if (rel === '..' || rel.startsWith(`..${sep}`) || paths.has(path)) throw new Error('Workspace path escapes root or is duplicated');
    const manifest = await json(resolve(path, 'package.json'));
    if (typeof manifest.name !== 'string' || !semver.valid(manifest.version) || names.has(manifest.name))
      throw new Error('Invalid/duplicate workspace identity');
    if (manifest.private !== undefined && typeof manifest.private !== 'boolean') throw new Error('Invalid private flag');
    names.add(manifest.name);
    paths.add(path);
    const hold = Object.hasOwn(policy.holds, manifest.name) ? policy.holds[manifest.name] : undefined;
    const selection = manifest.private ? 'private' : hold ? 'held-audit' : 'candidate';
    packages.push({
      name: manifest.name,
      version: manifest.version,
      path,
      sourcePath: rel || '.',
      manifest,
      selection,
      reason: manifest.private ? 'private:true; never packed' : hold || 'public inventory, not release authorization'
    });
  }
  if (!paths.has(root)) throw new Error('pnpm did not include root workspace');
  report.workspaces = packages.map(({ path, manifest, ...entry }) => entry);
  return packages;
}
