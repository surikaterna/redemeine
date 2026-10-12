import { readFile, readdir, lstat, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { VerifiedArtifact } from '../src/artifact';
import { budgets, publisherRevision } from './plan';
import { executeCommand } from './commands';
import { sha256 } from './receipts';
import { assert, record, string } from './schema';

async function git(root: string, args: readonly string[]): Promise<string> {
  const result = await executeCommand('git', args, root, budgets.commandMs, new AbortController().signal);
  assert(result.code === 0 && !result.signal, 'source_git_refused'); return result.stdout.trimEnd();
}

async function files(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === '.built') continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await files(path));
    else { assert(entry.isFile(), 'context_symlink_refused'); result.push(path); }
  }
  return result;
}

export async function harnessDigest(root: string): Promise<string> {
  const service = join(root, 'packages/projection-service');
  const selected = [...await files(join(service, 'integration')), join(service, 'package.json'), join(service, 'tsconfig.json'),
    ...['externalHarness.test.ts', 'harnessCancellation.test.ts', 'harnessCheckpoint.test.ts', 'harnessCreation.test.ts',
      'contextAndFeed.test.ts', 'mongoReadiness.test.ts', 'portDiagnostics.test.ts', 'networkPolicy.test.ts',
      'publisherCheckpoint.test.ts', 'publisherReturns.test.ts',
      'startupDiagnostics.test.ts', 'brokerManagementHttp.test.ts', 'diagnosticsIsolation.test.ts',
      'brokerTopology.test.ts', 'brokerRuntime.test.ts', 'support/brokerManagement.ts',
      'consumerActivation.test.ts', 'brokerActivation.test.ts', 'brokerEvidence.test.ts',
      'harnessLogCapture.test.ts', 'malformedRetention.test.ts',
      'retentionDeadline.test.ts', 'logChildLifecycle.test.ts',
      'support/harnessAbortProcess.ts', 'support/offlineTransport.ts', 'support/tsup.config.ts'].map((path) => join(service, 'test', path)),
    ...['src/startupDiagnostics.ts', 'src/observability.ts', 'src/infrastructure/brokerRuntime.ts', 'src/infrastructure/management.ts',
      'src/infrastructure/mongoBroker.ts', 'src/infrastructure/rabbitBroker.ts', 'src/infrastructure/brokerTopology.ts',
      'src/infrastructure/brokerSchema.ts',
      'src/infrastructure/brokerEvidence.ts', 'src/infrastructure/consumerActivation.ts', 'src/infrastructure/consumerFacts.ts',
      'dist/artifact.json'].map((path) => join(service, path)),
    join(root, 'pnpm-lock.yaml'), join(root, 'docs/architecture/projection-external-stack.md')];
  const manifest: string[] = [];
  for (const path of selected.sort()) manifest.push(`${sha256(await readFile(path))}  ${path.slice(root.length + 1)}\n`);
  return sha256(manifest.join(''));
}

export async function snapshot(root: string) {
  const base = await git(root, ['rev-parse', 'HEAD']);
  assert(base === '6d2fbc37d0a06d528436e2f41a05dfd8fe767d4b', 'projection_base_changed');
  const paths = [...new Set([...((await git(root, ['diff', '--name-only'])).split('\n')),
    ...((await git(root, ['ls-files', '--others', '--exclude-standard'])).split('\n'))])].filter(Boolean).sort();
  assert(paths.length <= 300, 'source_manifest_capacity');
  let manifest = '';
  for (const path of paths) manifest += `${await git(root, ['hash-object', path])}  ${path}\n`;
  return { base, manifest, digest: sha256(manifest), count: paths.length };
}

export async function assertPublisherPin(): Promise<void> {
  const root = '/opt/project/tapeworm';
  assert(await git(root, ['rev-parse', 'HEAD']) === publisherRevision, 'publisher_revision_changed');
  assert(await git(root, ['branch', '--show-current']) === 'develop', 'publisher_branch_changed');
  assert(await git(root, ['status', '--porcelain', '--untracked-files=all']) === '', 'publisher_dirty');
}

export function assertContextPath(path: string): void {
  const components = path.split('/');
  const forbidden = components.some((component) => component.startsWith('.env') || component.startsWith('.npmrc')
    || (component.startsWith('.git') && component !== '.gitignore' && component !== '.gitattributes'));
  assert(!forbidden && !/\.(pem|key)$/.test(path) && !path.includes('..') && !path.startsWith('/'), 'context_secret_path_refused');
}

export function assertContextFile(info: { isFile(): boolean; isSymbolicLink(): boolean }): void {
  assert(info.isFile() && !info.isSymbolicLink(), 'context_symlink_refused');
}

export async function publisherContext(destination: string) {
  await assertPublisherPin();
  const source = '/opt/project/tapeworm';
  const selected = (await git(source, ['ls-tree', '-r', '--name-only', 'HEAD', '--', 'package.json', 'package-lock.json',
    'turbo.json', 'tsconfig.base.json', 'packages/tapeworm', 'packages/tapeworm_dispatcher_mdb_rmq'])).split('\n');
  assert(selected.length <= budgets.sourceContextFiles, 'context_file_capacity');
  let bytes = 0; let manifest = '';
  for (const path of selected.sort()) {
    assertContextPath(path);
    const info = await lstat(join(source, path)); assertContextFile(info);
    const content = await readFile(join(source, path)); bytes += content.byteLength;
    assert(bytes <= budgets.sourceContextBytes, 'context_byte_capacity');
    await mkdir(dirname(join(destination, path)), { recursive: true });
    await writeFile(join(destination, path), content, { mode: info.mode & 0o111 ? 0o755 : 0o644 });
    manifest += `${sha256(content)}  ${path}\n`;
  }
  await assertPublisherPin();
  await writeFile(join(dirname(destination), 'publisher-input.manifest'), manifest, { mode: 0o600 });
  const metadata: unknown = JSON.parse(await readFile(join(source, 'packages/tapeworm_dispatcher_mdb_rmq/package.json'), 'utf8'));
  const core: unknown = JSON.parse(await readFile(join(source, 'packages/tapeworm/package.json'), 'utf8'));
  return { revision: publisherRevision, contextDigest: sha256(manifest), bytes, files: selected.length,
    version: string(record(metadata).version), coreVersion: string(record(core).version) };
}

export async function projectionContext(root: string, destination: string) {
  const service = join(root, 'packages/projection-service'); const artifact = await VerifiedArtifact.read(join(service, 'dist'));
  const value: unknown = JSON.parse(await readFile(join(service, 'dist/artifact.json'), 'utf8')); const receipt = record(value);
  assert(receipt.lockDigest === sha256(await readFile(join(root, 'pnpm-lock.yaml'))), 'artifact_lock_stale');
  for (const [path, hash] of Object.entries(record(receipt.inputs))) {
    const absolute = resolve(service, path); assert(absolute.startsWith(`${root}/`), 'artifact_input_path_refused');
    assert(sha256(await readFile(absolute)) === hash, 'artifact_input_stale');
  }
  await mkdir(destination, { recursive: true });
  for (const name of ['main.js', 'artifact.json', 'build-lock.sha256']) await writeFile(join(destination, name), await readFile(join(service, 'dist', name)), { mode: 0o644 });
  for (const name of ['Projection.Dockerfile', 'qualification-entry.sh']) await writeFile(join(destination, name), await readFile(join(service, 'integration', name)), { mode: 0o755 });
  return { artifactDigest: artifact.digest, registryDigest: artifact.registryDigest, protectedManifest: receipt.protectedManifest,
    mainSha256: sha256(await readFile(join(destination, 'main.js'))) };
}
