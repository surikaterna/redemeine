import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { smoke } from './smoke.mjs';
import { sha256, verifyLock } from './verify.mjs';

const job = JSON.parse(await readFile('/job/job.json', 'utf8'));
const result = { exitCode: 2, commands: [], root: job.roots, node: process.versions.node, smokes: job.smokes, phases: {}, notValidated: [] };
const env = {
  PATH: '/usr/local/bin:/usr/bin:/bin',
  HOME: '/home/consumer',
  npm_config_userconfig: '/home/consumer/user.npmrc',
  npm_config_globalconfig: '/home/consumer/global.npmrc',
  npm_config_cache: '/home/consumer/cache',
  npm_config_registry: job.endpoint
};

function command(program, args, diagnostic = false) {
  const run = spawnSync(program, args, { cwd: '/consumer', env, encoding: 'utf8', timeout: 90000, maxBuffer: 4 * 1024 * 1024 });
  const log = `${run.stdout || ''}${run.stderr || ''}`;
  result.commands.push({ program, args, exit: run.status, diagnostic, log, logSha256: sha256(log) });
  if (diagnostic) return { exit: run.status, log };
  if (run.status !== 0)
    throw Object.assign(new Error('Consumer command failed; see receipt'), {
      code: run.error || /EAI_AGAIN|ENOTFOUND|ETIMEDOUT|ECONN|ENETUNREACH|EHOSTUNREACH|E5\d\d/.test(log) ? 2 : 1
    });
  return run.stdout;
}

async function connectivity() {
  let externalReachable = false;
  try {
    await fetch('https://registry.npmjs.org/', { signal: AbortSignal.timeout(2000), redirect: 'error' });
    externalReachable = true;
  } catch {
    /* An internal network must not provide a direct external route. */
  }
  result.connectivity = { directExternalReachable: externalReachable };
  if (externalReachable) throw new Error('Consumer has unexpected direct internet connectivity');
}

try {
  await mkdir('/home/consumer', { mode: 0o700 });
  await writeFile('/home/consumer/user.npmrc', '', { mode: 0o600 });
  await writeFile('/home/consumer/global.npmrc', '', { mode: 0o600 });
  await writeFile('/consumer/package.json', JSON.stringify({ name: 'isolated-consumer', private: true, type: 'module' }));
  result.npm = command('npm', ['--version']).trim();
  result.environment = env;
  await connectivity();
  command('npm', [
    'install',
    ...job.roots,
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--save-exact',
    '--fetch-retries=0',
    '--fetch-timeout=15000',
    '--registry',
    job.endpoint
  ]);
  result.phases.install = 'passed';
  command('npm', ['ls', '--all']);
  result.phases.ls = 'passed';
  await verifyLock(job, result);
  result.phases.lock = 'passed';
  result.phases.installedGraph = 'passed';
  await smoke(job, command, result);
  result.exitCode = 0;
} catch (error) {
  result.exitCode = Number.isInteger(error.code) ? error.code : error.code === 'ERR_ASSERTION' ? 1 : 2;
  result.failureKind = error.kind || (result.exitCode === 1 ? 'artifact-failure' : 'infrastructure');
  result.error = error.message;
  result.notValidated.push('consumer scope did not complete; consult commands and partial adapter outcomes');
} finally {
  await writeFile('/job/result.json', JSON.stringify(result, null, 2));
  process.exitCode = result.exitCode;
}
