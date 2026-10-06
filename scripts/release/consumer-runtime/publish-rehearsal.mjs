import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { registryRequest } from './registry-http.mjs';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const integrity = (bytes) => `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
const result = { exitCode: 2, commands: [], observations: [] };
const job = JSON.parse(await readFile('/job/job.json', 'utf8'));
let ledger;
let token;
let locked = false;
const env = {
  PATH: '/usr/local/bin:/usr/bin:/bin',
  HOME: '/tmp/rehearsal',
  npm_config_userconfig: '/tmp/rehearsal/user.npmrc',
  npm_config_globalconfig: '/tmp/rehearsal/global.npmrc',
  npm_config_cache: '/tmp/rehearsal/cache'
};

function check(condition, message, code = 2) {
  if (!condition) throw Object.assign(new Error(message), { code });
}

const request = (path, options) => registryRequest(job.endpoint, path, options);

async function persist() {
  const bytes = Buffer.from(`${JSON.stringify(ledger)}\n`);
  const handle = await open('/job/ledger.tmp', 'w', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename('/job/ledger.tmp', '/job/ledger.json');
  const directory = await open('/job', 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
  result.ledgerSha256 = sha256(bytes);
}

function binding() {
  return {
    envelope: job.envelope,
    source: job.source,
    runId: job.runId,
    registryId: job.registryId,
    workerId: job.workerId,
    endpoint: job.endpoint,
    uploadTag: job.uploadTag,
    destinationTag: job.destinationTag,
    artifacts: job.artifacts
  };
}

async function initializeLedger() {
  if (job.resumeSha256) {
    const bytes = await readFile('/job/ledger.json');
    check(sha256(bytes) === job.resumeSha256, 'Resume ledger digest changed');
    result.ledgerSha256 = sha256(bytes);
    ledger = JSON.parse(bytes);
    check(JSON.stringify(ledger.binding) === JSON.stringify(binding()), 'Resume identity changed');
    check(
      ledger.artifacts.length === job.artifacts.length && ledger.tags.length === job.artifacts.filter((a) => a.candidate).length,
      'Resume ledger inventory changed'
    );
    check(
      ledger.artifacts.every(
        (entry, index) =>
          entry.key === job.artifacts[index].key &&
          ['planned', 'uploading', 'uploaded-unconfirmed', 'confirmed', 'already-identical', 'conflict', 'blocked'].includes(entry.state)
      ),
      'Invalid artifact ledger'
    );
    check(
      ledger.tags.every(
        (entry, index) => entry.key === job.artifacts.filter((a) => a.candidate)[index].key && ['planned', 'confirmed', 'ambiguous'].includes(entry.state)
      ),
      'Invalid tag ledger'
    );
    return;
  }
  try {
    await readFile('/job/ledger.json');
    check(false, 'Existing ledger requires bound resume');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  ledger = {
    binding: binding(),
    artifacts: job.artifacts.map((a) => ({ key: a.key, state: 'planned' })),
    tags: job.artifacts.filter((a) => a.candidate).map((a) => ({ key: a.key, state: 'planned' }))
  };
  await persist();
}

async function metadata(artifact) {
  try {
    return JSON.parse((await request(encodeURIComponent(artifact.name))).toString('utf8'));
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}

async function observe(artifact) {
  const data = await metadata(artifact);
  const version = data?.versions?.[artifact.version];
  if (!version) return { state: 'absent' };
  check(version.name === artifact.name && version.version === artifact.version, 'Registry identity conflict', 1);
  const bytes = await request(version.dist?.tarball);
  const observed = { key: artifact.key, sha256: sha256(bytes), integrity: integrity(bytes), dist: version.dist };
  result.observations.push(observed);
  check(
    observed.sha256 === artifact.sha256 && observed.integrity === artifact.integrity && version.dist.integrity === artifact.integrity,
    'Registry has conflicting original bytes; never overwrite',
    1
  );
  return { state: 'identical', metadata: data };
}

async function confirmAbsent(artifact) {
  const first = await observe(artifact);
  if (first.state !== 'absent') return first;
  await new Promise((accept) => setTimeout(accept, 200));
  return observe(artifact);
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
  throw new Error('Owned registry readiness deadline exceeded');
}

async function authenticate() {
  await mkdir('/tmp/rehearsal', { recursive: true, mode: 0o700 });
  await writeFile('/tmp/rehearsal/global.npmrc', '', { mode: 0o600 });
  try {
    token = await readFile('/tmp/rehearsal/token', 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
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
    await writeFile('/tmp/rehearsal/token', token, { flag: 'wx', mode: 0o600 });
  }
  await writeFile('/tmp/rehearsal/user.npmrc', `registry=${job.endpoint}\n//${new URL(job.endpoint).host}/:_authToken=${token}\n`, { mode: 0o600 });
}

function npm(args) {
  const command = spawnSync(
    'npm',
    [...args, '--ignore-scripts', '--provenance=false', '--fetch-retries=0', '--registry', job.endpoint, '--no-audit', '--no-fund'],
    { cwd: '/tmp/rehearsal', env, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 }
  );
  const log = `${command.stdout || ''}${command.stderr || ''}`.split(token).join('[REDACTED]');
  result.commands.push({ program: 'npm', args, exit: command.status, log, logSha256: sha256(log) });
  return command.status === 0;
}

async function preflight() {
  check(
    process.versions.node === '22.23.3' && JSON.parse(await readFile('/usr/local/lib/node_modules/npm/package.json', 'utf8')).version === '11.19.0',
    'Publisher tool pin mismatch'
  );
  check(job.endpoint === `http://${job.runId}-registry:4873/` && /^consumer-[a-f0-9-]{36}$/.test(job.runId), 'Not a generated owned endpoint');
  check(/^[a-f0-9]{64}$/.test(job.registryId) && /^[a-f0-9]{64}$/.test(job.workerId), 'Missing owned container identities');
  check(/^rehearsal-[a-f0-9]{24}$/.test(job.uploadTag) && ['pre', 'latest'].includes(job.destinationTag), 'Invalid explicit tags');
  check(new Set(job.artifacts.map((a) => a.key)).size === job.artifacts.length && job.artifacts.length > 0, 'Invalid artifact inventory');
  for (const [index, artifact] of job.artifacts.entries()) {
    check(artifact.file === `${index}.tgz`, 'Invalid artifact path');
    const bytes = await readFile(`/job/${artifact.file}`);
    check(sha256(bytes) === artifact.sha256 && integrity(bytes) === artifact.integrity, 'Artifact changed before mutation');
  }
  await initializeLedger();
  await readiness();
  for (const artifact of job.artifacts) await confirmAbsent(artifact);
}

async function upload(artifact, index) {
  const entry = ledger.artifacts[index];
  const observed = await confirmAbsent(artifact);
  if (observed.state === 'identical') {
    entry.state = 'already-identical';
    await persist();
    return;
  }
  entry.state = 'uploading';
  await persist();
  const bytes = await readFile(`/job/${artifact.file}`);
  check(sha256(bytes) === artifact.sha256 && integrity(bytes) === artifact.integrity, 'Artifact changed immediately before upload');
  const accepted = npm(['publish', `/job/${artifact.file}`, '--tag', job.uploadTag]);
  entry.state = 'uploaded-unconfirmed';
  await persist();
  check(accepted, 'Upload observation lost/failed; readback reconciliation required, no blind retry');
  check((await observe(artifact)).state === 'identical', 'Uploaded artifact readback not yet visible');
  entry.state = 'confirmed';
  await persist();
}

async function promote(artifact, index) {
  const entry = ledger.tags[index];
  const observed = await observe(artifact);
  check(observed.state === 'identical', 'Promotion requires fresh original-byte reconciliation');
  if (observed.metadata['dist-tags']?.[job.destinationTag] === artifact.version) {
    entry.state = 'confirmed';
    await persist();
    return;
  }
  entry.state = 'ambiguous';
  await persist();
  check(npm(['dist-tag', 'add', artifact.key, job.destinationTag]), 'Tag observation lost; reconciliation required');
  check((await metadata(artifact))?.['dist-tags']?.[job.destinationTag] === artifact.version, 'Tag readback ambiguous');
  entry.state = 'confirmed';
  await persist();
}

try {
  await mkdir('/job/release-lock');
  locked = true;
  await preflight();
  await authenticate();
  for (const [index, artifact] of job.artifacts.entries()) await upload(artifact, index);
  for (const artifact of job.artifacts) check((await observe(artifact)).state === 'identical', 'All artifacts must reconcile before ANY promotion');
  for (const [index, artifact] of job.artifacts.filter((a) => a.candidate).entries()) await promote(artifact, index);
  result.exitCode = 0;
} catch (error) {
  result.exitCode = error.code === 1 ? 1 : 2;
  result.error = token ? error.message.split(token).join('[REDACTED]') : error.message;
} finally {
  result.ledger = ledger;
  if (locked) await rm('/job/release-lock', { recursive: true });
  await writeFile('/job/result.json', JSON.stringify(result, null, 2), { mode: 0o600 });
  process.exitCode = result.exitCode;
}
