import { spawn } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { receiptPackageVersions } from './installed-versions.mjs';

const MONGO_IMAGE = 'mongo:7.0.16';
const RABBIT_IMAGE = 'rabbitmq:4.1.4-management-alpine';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const suffix = `${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2, 8)}`;
const runId = `wrdf-${suffix}`;
const resources = {
  network: `${runId}-net`,
  mongoVolume: `${runId}-mongo-data`,
  rabbitVolume: `${runId}-rabbit-data`,
  mongo: `${runId}-mongo`,
  rabbit: `${runId}-rabbit`
};
const receiptPath = `/tmp/opencode/redemeine-wrdf-${suffix}.json`;
const jestResultPath = `/tmp/opencode/redemeine-wrdf-${suffix}-jest.json`;
const invocation = process.env.REDEMEINE_REAL_INVOCATION ?? 'follow-up';
const startedAt = new Date();
let testExitCode = null;
let failure = null;
let versions = {};
let cleanup = {};
let scenarios = [];

function execute(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? root,
      env: options.env ?? process.env,
      stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit'
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0 || options.allowFailure) resolve({ code: code ?? 1, stdout: stdout.trim(), stderr: stderr.trim() });
      else reject(new Error(`${command} ${args.join(' ')} failed (${code}): ${stderr.trim()}`));
    });
  });
}

async function docker(args, options = {}) {
  return execute('docker', args, { ...options, capture: options.capture ?? true });
}

async function poll(label, probe, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      if (await probe()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${label} readiness timed out${lastError instanceof Error ? `: ${lastError.message}` : ''}`);
}

async function mappedPort(container, port) {
  const result = await docker(['port', container, `${port}/tcp`]);
  const match = result.stdout.match(/127\.0\.0\.1:(\d+)/);
  if (!match?.[1]) throw new Error(`missing localhost mapping for ${container}:${port}`);
  return Number(match[1]);
}

async function createResources() {
  await docker(['pull', MONGO_IMAGE], { capture: false });
  await docker(['pull', RABBIT_IMAGE], { capture: false });
  await docker(['network', 'create', resources.network]);
  await docker(['volume', 'create', resources.mongoVolume]);
  await docker(['volume', 'create', resources.rabbitVolume]);
  await docker([
    'run',
    '-d',
    '--name',
    resources.mongo,
    '--network',
    resources.network,
    '--network-alias',
    'mongo',
    '--mount',
    `source=${resources.mongoVolume},target=/data/db`,
    '-p',
    '127.0.0.1::27017',
    MONGO_IMAGE,
    '--replSet',
    'rs0',
    '--bind_ip_all',
    '--port',
    '27017'
  ]);
  await docker([
    'run',
    '-d',
    '--name',
    resources.rabbit,
    '--network',
    resources.network,
    '--mount',
    `source=${resources.rabbitVolume},target=/var/lib/rabbitmq`,
    '-e',
    'RABBITMQ_DEFAULT_USER=saga_test',
    '-e',
    'RABBITMQ_DEFAULT_PASS=saga_test_password',
    '-p',
    '127.0.0.1::5672',
    '-p',
    '127.0.0.1::15672',
    RABBIT_IMAGE
  ]);
}

async function waitForServices() {
  await poll(
    'MongoDB',
    async () => (await docker(['exec', resources.mongo, 'mongosh', '--quiet', '--eval', 'db.adminCommand({ping:1}).ok'], { allowFailure: true })).code === 0
  );
  await docker(['exec', resources.mongo, 'mongosh', '--quiet', '--eval', "rs.initiate({_id:'rs0',members:[{_id:0,host:'mongo:27017'}]})"]);
  await poll(
    'MongoDB primary',
    async () =>
      (await docker(['exec', resources.mongo, 'mongosh', '--quiet', '--eval', 'db.hello().isWritablePrimary'], { allowFailure: true })).stdout === 'true'
  );
  await poll('RabbitMQ', async () => (await docker(['exec', resources.rabbit, 'rabbitmq-diagnostics', '-q', 'ping'], { allowFailure: true })).code === 0);
}

async function collectVersions() {
  const mongo = await docker(['exec', resources.mongo, 'mongod', '--version']);
  const rabbit = await docker(['exec', resources.rabbit, 'rabbitmqctl', 'version']);
  const mongoImage = await docker(['image', 'inspect', '--format', '{{.Id}}', MONGO_IMAGE]);
  const rabbitImage = await docker(['image', 'inspect', '--format', '{{.Id}}', RABBIT_IMAGE]);
  const mongoContainerImage = await docker(['inspect', '--format', '{{.Image}}', resources.mongo]);
  const rabbitContainerImage = await docker(['inspect', '--format', '{{.Image}}', resources.rabbit]);
  if (mongoContainerImage.stdout !== mongoImage.stdout || rabbitContainerImage.stdout !== rabbitImage.stdout) {
    throw new Error('Running service image digest does not match the pinned image');
  }
  if (!mongo.stdout.startsWith(`db version v${MONGO_IMAGE.split(':')[1]}`) ||
      rabbit.stdout.split('\n').at(-1) !== RABBIT_IMAGE.split(':')[1].split('-')[0]) {
    throw new Error('Running service version does not match the pinned image tag');
  }
  versions = {
    mongo: mongo.stdout.split('\n')[0],
    rabbitmq: rabbit.stdout.split('\n').at(-1),
    mongoImage: MONGO_IMAGE,
    mongoImageId: mongoImage.stdout,
    rabbitImage: RABBIT_IMAGE,
    rabbitImageId: rabbitImage.stdout,
    tapeworm: '0.6.0',
    mongodbAdapter: '3.1.0',
    dispatcher: '0.2.0',
    amqplib: '2.0.1',
    ...receiptPackageVersions()
  };
}

async function runTests() {
  const mongoPort = await mappedPort(resources.mongo, 27017);
  const rabbitPort = await mappedPort(resources.rabbit, 5672);
  const managementPort = await mappedPort(resources.rabbit, 15672);
  const env = {
    ...process.env,
    REDEMEINE_REAL_STACK: '1',
    REDEMEINE_REAL_RUN_ID: runId.replaceAll('-', '_'),
    REDEMEINE_MONGO_URL: `mongodb://127.0.0.1:${mongoPort}/?replicaSet=rs0&directConnection=true`,
    REDEMEINE_RABBIT_URL: `amqp://saga_test:saga_test_password@127.0.0.1:${rabbitPort}`,
    REDEMEINE_RABBIT_MANAGEMENT_URL: `http://127.0.0.1:${managementPort}`,
    REDEMEINE_RABBIT_USER: 'saga_test',
    REDEMEINE_RABBIT_PASSWORD: 'saga_test_password'
  };
  const result = await execute(
    'pnpm',
    [
      'exec',
      'jest',
      '--config',
      'jest.config.js',
      '--runInBand',
      '--json',
      '--outputFile',
      jestResultPath,
      '--runTestsByPath',
      'packages/saga-worker-rabbitmq/integration/saga-real-stack.integration.test.ts'
    ],
    { cwd: root, env, allowFailure: true }
  );
  testExitCode = result.code;
  await collectScenarios();
  if (result.code !== 0) throw new Error(`real-stack Jest invocation failed with exit code ${result.code}`);
}

async function collectScenarios() {
  try {
    const report = JSON.parse(await readFile(jestResultPath, 'utf8'));
    scenarios = report.testResults.flatMap(({ assertionResults }) =>
      assertionResults.map(({ ancestorTitles, title, status, duration, failureMessages }) => ({
        name: [...ancestorTitles, title].join(' > '),
        status,
        durationMs: duration ?? null,
        failures: failureMessages
      }))
    );
  } catch (error) {
    scenarios = [{ name: 'Jest infrastructure', status: 'failed', durationMs: null, failures: [String(error)] }];
  } finally {
    await rm(jestResultPath, { force: true });
  }
}

async function removeResources() {
  await docker(['rm', '-f', resources.mongo, resources.rabbit], { allowFailure: true });
  await docker(['volume', 'rm', resources.mongoVolume, resources.rabbitVolume], { allowFailure: true });
  await docker(['network', 'rm', resources.network], { allowFailure: true });
  const containers = await docker(['ps', '-a', '--filter', `name=${runId}`, '--format', '{{.Names}}']);
  const volumes = await docker(['volume', 'ls', '--filter', `name=${runId}`, '--format', '{{.Name}}']);
  const networks = await docker(['network', 'ls', '--filter', `name=${runId}`, '--format', '{{.Name}}']);
  cleanup = {
    containersRemaining: containers.stdout ? containers.stdout.split('\n') : [],
    volumesRemaining: volumes.stdout ? volumes.stdout.split('\n') : [],
    networksRemaining: networks.stdout ? networks.stdout.split('\n') : []
  };
}

try {
  await createResources();
  await waitForServices();
  await collectVersions();
  await runTests();
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  await removeResources();
  const finishedAt = new Date();
  await writeFile(
    receiptPath,
    `${JSON.stringify(
      {
        issue: 'redemeine-wrdf',
        invocation,
        firstFullInvocation: invocation === 'first',
        runId,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        testExitCode,
        scenarios,
        failure,
        versions,
        cleanup
      },
      null,
      2
    )}\n`
  );
  console.log(`Real-stack receipt: ${receiptPath}`);
}
