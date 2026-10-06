import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { registryRequest } from './registry-http.mjs';

const job = JSON.parse(await readFile('/job/job.json', 'utf8'));
const result = { exitCode: 2, receipts: [], commands: [] };
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const integrity = (bytes) => `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
let token;

function check(condition, message, code = 2) {
  if (!condition) throw Object.assign(new Error(message), { code });
}

async function request(path, options = {}) {
  return registryRequest(job.endpoint, path, options);
}

async function readiness() {
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      await request('-/ping');
      return;
    } catch {
      await new Promise((accept) => setTimeout(accept, 300));
    }
  }
  throw new Error('Registry readiness deadline exceeded');
}

async function authenticate() {
  const name = `run-${randomUUID()}`;
  const data = JSON.parse(
    (
      await request(`-/user/org.couchdb.user:${name}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, password: randomUUID(), email: 'disposable@example.invalid', type: 'user', roles: [] })
      })
    ).toString('utf8')
  );
  check(typeof data.token === 'string' && data.token.length > 0, 'Missing ephemeral local token');
  token = data.token;
  const authority = new URL(job.endpoint).host;
  await writeFile('/tmp/stager/user.npmrc', `registry=${job.endpoint}\n//${authority}/:_authToken=${token}\n`, { mode: 0o600 });
}

function publish(artifact) {
  const args = [
    'publish',
    `/job/${artifact.file}`,
    '--ignore-scripts',
    '--provenance=false',
    '--fetch-retries=0',
    '--registry',
    job.endpoint,
    '--tag',
    'local-qualification',
    '--no-audit',
    '--no-fund'
  ];
  const env = {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    HOME: '/tmp/stager',
    npm_config_userconfig: '/tmp/stager/user.npmrc',
    npm_config_globalconfig: '/tmp/stager/global.npmrc',
    npm_config_cache: '/tmp/stager/cache'
  };
  const command = spawnSync('npm', args, { cwd: '/tmp/stager', env, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 });
  const output = `${command.stdout || ''}${command.stderr || ''}`.split(token).join('[REDACTED]');
  result.commands.push({ command: 'npm', args, exit: command.status, log: output, logSha256: sha256(output) });
  check(command.status === 0, 'Local tarball upload failed (no automatic retry)', 2);
}

async function stageArtifact(artifact) {
  const bytes = await readFile(`/job/${artifact.file}`);
  check(sha256(bytes) === artifact.sha256 && integrity(bytes) === artifact.integrity, 'Stager input digest mismatch');
  publish(artifact);
  const metadata = JSON.parse((await request(encodeURIComponent(artifact.name))).toString('utf8'));
  const dist = metadata.versions?.[artifact.version]?.dist;
  check(dist?.integrity === artifact.integrity, 'Staged dist.integrity mismatch', 1);
  const downloaded = await request(dist.tarball);
  check(sha256(downloaded) === artifact.sha256 && integrity(downloaded) === artifact.integrity, 'Staged tarball bytes changed', 1);
  result.receipts.push({
    ...artifact,
    downloadedSha256: sha256(downloaded),
    downloadedIntegrity: integrity(downloaded),
    dist,
    metadataSha256: sha256(JSON.stringify(metadata))
  });
}

try {
  check(/^http:\/\/consumer-[a-f0-9-]+-registry:4873\/$/.test(job.endpoint), 'Non-generated staging endpoint');
  await mkdir('/tmp/stager', { mode: 0o700 });
  await writeFile('/tmp/stager/global.npmrc', '', { mode: 0o600 });
  await readiness();
  await authenticate();
  for (const artifact of job.artifacts) await stageArtifact(artifact);
  result.exitCode = 0;
} catch (error) {
  result.exitCode = Number.isInteger(error.code) ? error.code : 2;
  result.error = token ? error.message.split(token).join('[REDACTED]') : error.message;
} finally {
  await rm('/tmp/stager', { recursive: true, force: true });
  token = undefined;
  await writeFile('/job/result.json', JSON.stringify(result, null, 2));
  process.exitCode = result.exitCode;
}
