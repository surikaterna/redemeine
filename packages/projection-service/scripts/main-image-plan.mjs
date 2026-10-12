import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBuildContextClosure } from './main-image-context.mjs';

export const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const directories = ['aggregate', 'kernel', 'projection', 'projection-runtime-core', 'projection-runtime-store-mongodb',
  'projection-router-core', 'projection-worker-core', 'projection-transport', 'projection-service'].map((name) => `packages/${name}/`);
const rootFiles = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.base.json', 'tsup.config.base.ts', 'turbo.json', 'LICENSE', '.dockerignore',
  'docs/architecture/projection-live-inline-runtime.md', '.github/workflows/publish.yml',
  '.github/workflows/projection-image.yml', '.github/scripts/projection-image-metadata.mjs',
  '.github/tests/projection-image-metadata.test.mjs', 'docs/releases/projection-runtime.md'];

async function sourceSnapshot() {
  const paths = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' })
    .split('\0').filter((path) => rootFiles.includes(path) || directories.some((prefix) => path.startsWith(prefix))).sort();
  const entries = {};
  for (const path of paths) entries[path] = sha256(await readFile(join(root, path)));
  return { entries, digest: sha256(JSON.stringify(entries)) };
}

export const dummyEnvironment = {
  MONGODB_URI: 'mongodb://127.0.0.1:27017', MONGODB_DATABASE: 'packaging_smoke', MONGODB_COMMITS_COLLECTION: 'commits',
  RABBITMQ_URI: 'amqp://smoke:dummy@127.0.0.1:5672/smoke', RABBITMQ_VHOST: 'smoke', RABBITMQ_EXCHANGE: 'packaging.smoke',
  PROJECTION_PARTITION_ID: 'smoke', RABBITMQ_MANAGEMENT_URL: 'https://127.0.0.1:15671',
  RABBITMQ_MANAGEMENT_USERNAME: 'smoke', RABBITMQ_MANAGEMENT_PASSWORD: 'dummy', CONNECT_TIMEOUT_MS: '1000'
};

export async function imagePlan(run) {
  if (!/^[a-f0-9]{16}$/.test(run)) throw new Error('invalid_owned_run_id');
  const buildContextClosure = await readBuildContextClosure(root);
  const source = await sourceSnapshot(); const image = `redemeine-projection-worker-main-smoke:${run}`;
  const directory = `/tmp/opencode/hpq1-main-smoke-${run}`;
  const labels = { 'redemeine.issue': 'redemeine-hpq1.2', 'redemeine.run': run, 'redemeine.source': source.digest };
  const labelArgs = Object.entries(labels).flatMap(([key, value]) => ['--label', `${key}=${value}`]);
  const build = ['build', '--memory', '2g', '--memory-swap', '2g', '--cpu-period', '100000', '--cpu-quota', '100000', ...labelArgs,
    '--build-arg', 'VCS_REF=uncommitted-source-snapshot', '--build-arg', 'IMAGE_VERSION=0.1.0-rc.1',
    '-f', 'packages/projection-service/Dockerfile', '-t', image, '.'];
  const containers = ['missing', 'invalid'].map((kind) => {
    const name = `hpq1-main-${run}-${kind}`;
    const environment = { ...dummyEnvironment, ...(kind === 'invalid' ? { PROJECTION_DEFINITIONS_MODULE: '/app/definitions/invalid.mjs' } : {}) };
    const create = ['create', '--name', name, ...labelArgs, '--network', 'none', '--memory', '512m', '--memory-swap', '512m', '--cpus', '0.5', '--pids-limit', '128',
      '--read-only', '--security-opt', 'no-new-privileges', '--cap-drop', 'ALL', '--log-driver', 'local', '--log-opt', 'max-size=1m',
      '--log-opt', 'max-file=2', '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=16m',
      ...Object.entries(environment).flatMap(([key, value]) => ['--env', `${key}=${value}`]),
      ...(kind === 'invalid' ? ['--mount', `type=bind,source=${directory}/invalid.mjs,target=/app/definitions/invalid.mjs,readonly`] : []), image];
    return { kind, name, create, expectedExitCode: 78, expectedDiagnostic: kind === 'missing'
      ? { reason: 'invalid_configuration', variable: 'PROJECTION_DEFINITIONS_MODULE', detail: 'required' }
      : { reason: 'definition_bundle_invalid', productionReady: false } };
  });
  const worker = JSON.parse(await readFile(join(root, 'packages/projection-service/dist-worker/artifact.json')));
  const plan = { issue: 'redemeine-hpq1.2', source, buildContextClosure, workerDigest: worker.digest, image, directory, labels, build, containers,
    dockerPrefix: ['--host', 'unix:///var/run/docker.sock'], buildEnvironment: { DOCKER_BUILDKIT: '0' },
    deadlines: { build: 900000, smoke: 30000, command: 10000, cleanup: 120000 },
    daemonCapabilities: ['OSType=linux', 'MemoryLimit', 'SwapLimit', 'CpuCfsQuota', 'CpuCfsPeriod', 'PidsLimit'],
    actualContainerChecks: ['Memory=536870912', 'MemorySwap=536870912', 'NanoCpus=500000000', 'PidsLimit=128', 'ReadonlyRootfs',
      'Privileged=false', 'CapDrop=ALL', 'CapAdd=empty', 'no-new-privileges', 'LogConfig=local/1m/2', 'no published ports', 'only planned mounts', 'no implicit volumes'],
    buildDiagnostics: 'Closed allowlisted step/instruction, pnpm/npm error codes, known workspace names and TS error codes only; no raw text/Config.Env/URI/credentials. 1MiB capture,64 records/32KiB JSON, private0600 under owned0700 run dir,2s write budget; unknown details omitted.',
    payloadChecks: ['main.js', 'artifact.json', 'build-lock.sha256', 'package.json', 'LICENSE', 'licenses/DEPENDENCIES.json'],
    inspections: [['cp', '<missing-container-ID>:/app/.', '-'], ['cp', '<missing-container-ID>:/var/lib/redemeine-projection', '-'],
      ...['/usr/bin/tini', '/usr/bin/flock', '/etc/ssl/certs/ca-certificates.crt'].map((path) => ['cp', `<missing-container-ID>:${path}`, '-'])],
    cleanup: ['attempted intent only: container inspect <owned-name> -> compare recorded ID/name/labels -> rm --force <exact-ID> -> inspect absence',
      'attempted intent only: image inspect <owned-tag> -> compare recorded ID/labels/tag -> image rm <owned-tag> -> inspect absence'],
    limits: 'One local image plus two network=none smoke containers only; no volume/network/service creation, no prune/push, no ready200 claim',
    failurePolicy: 'Finite CLI deadlines/output caps; uncertain create/build may outlive CLI, recorded as uncertainty and never passed as clean. No automatic retry or daemon repair.' };
  return { ...plan, reviewDigest: sha256(JSON.stringify(plan)) };
}
