import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { receiptPackageVersions } from './installed-versions.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const runId = `topology-${randomBytes(8).toString('hex')}`;
const volume = `${runId}-data`;
const image = 'rabbitmq:4.1.4-management-alpine';
const receiptPath = `/tmp/opencode/redemeine-fyp3.3-${runId}.json`;
const reportPath = `/tmp/opencode/redemeine-fyp3.3-${runId}-jest.json`;
let interrupted = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { interrupted = true; });

function run(command, args, { env = process.env, allowed = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (part) => { stdout += part; });
    child.stderr.on('data', (part) => { stderr += part; });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0 || allowed) resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() });
      else reject(new Error(`${command} operation failed (${code}): ${stderr.trim()}`));
    });
  });
}

const docker = (args, options) => run('docker', args, options);

async function waitReady() {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline && !interrupted) {
    const probe = await docker(['exec', runId, 'rabbitmq-diagnostics', '-q', 'ping'], { allowed: true });
    if (probe.code === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('Rabbit readiness timed out/interrupted');
}

async function setup() {
  await docker(['pull', image]);
  await docker(['volume', 'create', volume]);
  await docker(['run', '-d', '--name', runId, '--mount', `source=${volume},target=/var/lib/rabbitmq`,
    '-e', 'RABBITMQ_DEFAULT_USER=topology_owner', '-e', 'RABBITMQ_DEFAULT_PASS=topology_owner_password',
    '-p', '127.0.0.1::5672', image]);
  await waitReady();
  await docker(['exec', runId, 'rabbitmqctl', 'add_user', 'topology_restricted', 'topology_restricted_password']);
  await docker(['exec', runId, 'rabbitmqctl', 'set_permissions', '-p', '/', 'topology_restricted', '^$', '^$', '^$']);
  const id = (await docker(['image', 'inspect', '--format', '{{.Id}}', image])).stdout;
  const containerId = (await docker(['inspect', '--format', '{{.Image}}', runId])).stdout;
  const version = (await docker(['exec', runId, 'rabbitmqctl', 'version'])).stdout.split('\n').at(-1);
  if (id !== containerId || version !== '4.1.4') throw new Error('Rabbit image/version mismatch');
  const mapping = (await docker(['port', runId, '5672/tcp'])).stdout;
  const port = mapping.match(/127\.0\.0\.1:(\d+)/)?.[1];
  if (!port) throw new Error('localhost-only Rabbit port mapping missing');
  return { id, version, port };
}

async function cleanup() {
  const removal = [await docker(['rm', '-f', runId], { allowed: true }), await docker(['volume', 'rm', volume], { allowed: true })];
  const containers = await docker(['ps', '-a', '--filter', `name=^/${runId}$`, '--format', '{{.Names}}']);
  const volumes = await docker(['volume', 'ls', '--filter', `name=^${volume}$`, '--format', '{{.Name}}']);
  return { removalCodes: removal.map((result) => result.code), containersRemaining: containers.stdout, volumesRemaining: volumes.stdout };
}

async function main() {
  const receipt = { issue: 'redemeine-fyp3.3', runId, image, sha: (await run('git', ['rev-parse', 'HEAD'])).stdout,
    startedAt: new Date().toISOString(), versions: receiptPackageVersions(), scenarios: [], failure: null, exitCode: 1 };
  try {
    if ((await run('git', ['status', '--porcelain'])).stdout) throw new Error('Real audit requires clean committed HEAD');
    const { id, version, port } = await setup();
    receipt.imageId = id;
    receipt.rabbitmq = version;
    const env = { ...process.env, REDEMEINE_TOPOLOGY_RUN_ID: runId, REDEMEINE_TOPOLOGY_CONTAINER: runId,
      REDEMEINE_TOPOLOGY_URL: `amqp://topology_owner:topology_owner_password@127.0.0.1:${port}`,
      REDEMEINE_TOPOLOGY_RESTRICTED_URL: `amqp://topology_restricted:topology_restricted_password@127.0.0.1:${port}` };
    const result = await run('pnpm', ['exec', 'jest', '--config', 'jest.config.js', '--runInBand', '--json', '--outputFile', reportPath,
      '--runTestsByPath', 'packages/saga-worker-rabbitmq/integration/topology-real.integration.test.ts'], { env, allowed: true });
    receipt.testExitCode = result.code;
    const report = JSON.parse(await readFile(reportPath, 'utf8'));
    receipt.scenarios = report.testResults.flatMap((suite) => suite.assertionResults.map((test) => ({
      name: [...test.ancestorTitles, test.title].join(' > '), status: test.status, failures: test.failureMessages
    })));
    if (result.code !== 0 || interrupted) throw new Error('Real topology tests failed/interrupted; inspect receipt scenarios');
    receipt.exitCode = 0;
  } catch (error) {
    receipt.failure = error instanceof Error ? error.message : String(error);
  } finally {
    await rm(reportPath, { force: true });
    try {
      receipt.cleanup = await cleanup();
      if (receipt.cleanup.containersRemaining || receipt.cleanup.volumesRemaining) {
        receipt.failure = `Owned resources remain after cleanup; prior failure: ${receipt.failure}`;
        receipt.exitCode = 1;
      }
    } catch (error) {
      receipt.failure = `cleanup failed: ${String(error)}; prior failure: ${receipt.failure}`;
      receipt.exitCode = 1;
    }
    receipt.finishedAt = new Date().toISOString();
    const canonical = JSON.stringify(receipt);
    receipt.sha256 = createHash('sha256').update(canonical).digest('hex');
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
    console.log(`Topology audit receipt: ${receiptPath}`);
    process.exitCode = receipt.exitCode;
  }
}

await main();
