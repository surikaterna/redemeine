import { spawnSync } from 'node:child_process';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { cliGeneration } from './cli-generation.mjs';
import { sha256, verifyLock } from './verify.mjs';

const job = JSON.parse(await readFile('/job/job.json', 'utf8'));
const result = {
  purpose: 'test-only installed CLI facade: generator checker, NOT product CLI qualification',
  node: process.versions.node,
  commands: [],
  cases: []
};
const env = {
  PATH: '/usr/local/bin:/usr/bin:/bin',
  HOME: '/home/consumer',
  npm_config_cache: '/home/consumer/cache',
  npm_config_userconfig: '/home/consumer/user.npmrc',
  npm_config_globalconfig: '/home/consumer/global.npmrc',
  npm_config_registry: job.endpoint
};
let active = result;

function command(program, args, diagnostic = false) {
  const run = spawnSync(program, args, { cwd: '/consumer', env, encoding: 'utf8', timeout: 90000, maxBuffer: 4 * 1024 * 1024 });
  const log = `${run.stdout || ''}${run.stderr || ''}`;
  active.commands.push({ program, args, exit: run.status, log, logSha256: sha256(log) });
  if (diagnostic) return { exit: run.status, log };
  if (run.status !== 0) throw Object.assign(new Error('Fixture command failed'), { code: run.error ? 2 : 1 });
  return run.stdout;
}

async function runCase(name) {
  for (const path of ['src', 'generated.ts', 'generated-check.ts', 'generated-output']) await rm(`/consumer/${path}`, { recursive: true, force: true });
  await writeFile('/consumer/fixture-case', name);
  if (name === 'missing-host') await rename('/consumer/node_modules/@redemeine/aggregate', '/consumer/withheld-aggregate');
  active = { name, commands: [], phases: {}, notValidated: [] };
  try {
    await cliGeneration(command, active);
    active.exitCode = 0;
  } catch (error) {
    active.exitCode = Number.isInteger(error.code) ? error.code : error.code === 'ERR_ASSERTION' ? 1 : 2;
    active.failureKind = error.kind;
    active.error = error.message;
  }
  result.cases.push(active);
  for (const file of ['aggregate.ts', 'generated.ts']) {
    try {
      await writeFile(`/job/${name}-${file}`, await readFile(`/job/${file}`));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await rm(`/job/${file}`, { force: true });
  }
}

try {
  await mkdir('/home/consumer', { mode: 0o700 });
  for (const file of ['user.npmrc', 'global.npmrc']) await writeFile(`/home/consumer/${file}`, '');
  await writeFile('/consumer/package.json', JSON.stringify({ private: true, type: 'module' }));
  command('npm', ['install', ...job.roots, '--save-exact', '--ignore-scripts', '--no-audit', '--no-fund', '--fetch-retries=0']);
  command('npm', ['ls', '--all']);
  await verifyLock(job, result);
  for (const name of ['valid', 'syntax', 'types', 'comment', 'empty', 'coerce-id', 'coerce-state', 'bad-input', 'missing-host']) await runCase(name);
} catch (error) {
  result.setupError = error.message;
  process.exitCode = 2;
} finally {
  await writeFile('/job/result.json', JSON.stringify(result, null, 2));
}
