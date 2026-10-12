import { mkdtemp, rm, readFile, lstat, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { assertContextPath, assertContextFile, publisherContext } from '../integration/provenance';
import { exchangeName, partitionId, queueName, producerFeedEnvironment, projectionFeedEnvironment } from '../integration/plan';
import { parseConfig } from '../src/config';
import { bindingArguments } from '../src/infrastructure/brokerTopology';
import { externalEnvironment } from './fixtures';

test.each(['.git', '.git/config', 'nested/.git', 'nested/.git/refs/main', '.env', '.env.local',
  'nested/.env.credentials', 'nested/.npmrc', 'nested/private.key', 'nested/cert.pem', '../escape',
  '/absolute', '.gitconfig', '.github/config'])('context refuses metadata/secret/escape path %s', (path) => {
  expect(() => assertContextPath(path)).toThrow('context_secret_path_refused');
});

test.each(['.gitignore', '.gitattributes', 'packages/core/.gitignore', 'packages/core/.gitattributes'])('context allows safe data path %s', (path) => {
  expect(() => assertContextPath(path)).not.toThrow();
});

test('allowed dotfile data still must be a regular nonsymlink file, never a directory or worktree metadata link', async () => {
  const root = await mkdtemp('/tmp/opencode/hpq1-context-entry-');
  try {
    await symlink('/opt/project/tapeworm/package.json', join(root, '.gitignore'));
    expect(() => assertContextFile({ isFile: () => true, isSymbolicLink: () => false })).not.toThrow();
    const link = await lstat(join(root, '.gitignore')); const directory = await lstat(root);
    expect(() => assertContextFile(link)).toThrow('context_symlink_refused');
    expect(() => assertContextFile(directory)).toThrow('context_symlink_refused');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('complete pinned tracked publisher context stages offline including legitimate gitignore files', async () => {
  const root = await mkdtemp('/tmp/opencode/hpq1-context-full-');
  try {
    const destination = join(root, 'publisher-context'); const context = await publisherContext(destination);
    expect(context.revision).toBe('c2b657cb00dde60271e235dec917a7fee28d92f0');
    expect(context.files).toBeGreaterThan(2); expect(context.bytes).toBeLessThanOrEqual(67108864);
    expect(await readFile(join(destination, 'packages/tapeworm/.gitignore'), 'utf8'))
      .toBe(await readFile('/opt/project/tapeworm/packages/tapeworm/.gitignore', 'utf8'));
    expect((await readFile(join(root, 'publisher-input.manifest'), 'utf8')).split('\n').filter(Boolean)).toHaveLength(context.files);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test.each([undefined, 'explicit-tenant'])('master feed config supports optional tenant=%s without inventing a main-path filter', (tenant) => {
  expect(exchangeName).toBe(`tapeworm.${partitionId}.commits`); expect(partitionId).toBe('master');
  expect(queueName).toBe('rdm.projection.commits');
  expect(producerFeedEnvironment).not.toHaveProperty('TENANT');
  expect(projectionFeedEnvironment).not.toHaveProperty('PROJECTION_TENANT');
  const config = parseConfig({ ...externalEnvironment, ...projectionFeedEnvironment, PROJECTION_TENANT: tenant }, []);
  if (config.mode !== 'external') throw new Error('expected external');
  expect(config.external.tenant).toBe(tenant);
  expect(bindingArguments(config)).toEqual({ 'x-match': 'all', collection: 'commits', partitionId: 'master',
    ...(tenant === undefined ? {} : { tenant }) });
});
