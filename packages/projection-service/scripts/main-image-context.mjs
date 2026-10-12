import { readFile, readdir } from 'node:fs/promises';
import { posix, join } from 'node:path';
import assert from 'node:assert/strict';

export const rootBuildInputs = Object.freeze(['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.base.json', 'tsup.config.base.ts', 'turbo.json']);

function importerLinks(text) {
  const links = {}; let importer; let dependency; let active = false;
  for (const line of text.split('\n')) {
    if (line === 'importers:') { active = true; continue; }
    if (!active) continue;
    if (/^[^\s#]/.test(line)) break;
    const section = /^ {2}([a-zA-Z0-9_./-]+):$/.exec(line);
    if (section) { importer = section[1]; links[importer] = {}; dependency = undefined; continue; }
    const name = /^ {6}'?([^':]+)'?:$/.exec(line);
    if (name && importer) { dependency = name[1]; links[importer][dependency] = {}; continue; }
    const field = /^ {8}(specifier|version): (.+)$/.exec(line);
    if (field && importer && dependency) links[importer][dependency][field[1]] = field[2].replace(/^'(.*)'$/, '$1');
  }
  return links;
}

function copiedSources(dockerfile) {
  const build = dockerfile.split(/^FROM .* AS runtime$/m)[0];
  const sources = build.split('\n').filter((line) => line.startsWith('COPY ')).flatMap((line) => line.split(/\s+/).slice(1, -1));
  assert.ok(!sources.some((path) => path === '.' || path === './'), 'whole_context_copy_refused');
  return sources;
}
function included(path, sources) {
  return sources.some((source) => path === source || (source.endsWith('/') && path.startsWith(source)));
}
function workspaceDependencies(manifest) {
  return ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'].flatMap((group) =>
    Object.entries(manifest[group] ?? {}).filter(([, specifier]) => typeof specifier === 'string' && specifier.startsWith('workspace:'))
      .map(([name, specifier]) => ({ group, name, specifier })));
}

export function assertBuildContextClosure(manifests, lockText, dockerfile, target = '@redemeine/projection-service') {
  const byName = new Map(manifests.map((entry) => [entry.manifest.name, entry]));
  assert.equal(byName.size, manifests.length, 'duplicate_workspace_name');
  const links = importerLinks(lockText); const sources = copiedSources(dockerfile);
  for (const path of rootBuildInputs) assert.ok(included(path, sources), 'context_root_build_input_missing');
  const pending = [byName.get(target), manifests.find((entry) => entry.path === '.')]; const selected = new Set(); const edges = [];
  while (pending.length) {
    const entry = pending.pop(); assert.ok(entry, 'workspace_manifest_missing');
    if (selected.has(entry.path)) continue; selected.add(entry.path);
    const path = entry.path === '.' ? 'package.json' : `${entry.path}/package.json`;
    assert.ok(included(path, sources), 'workspace_copy_missing');
    for (const { group, name, specifier } of workspaceDependencies(entry.manifest)) {
        const dependency = byName.get(name); assert.ok(dependency, 'workspace_manifest_missing');
        const locked = links[entry.path]?.[name]; assert.equal(locked?.specifier, specifier, 'workspace_lock_specifier_mismatch');
        assert.ok(locked.version?.startsWith('link:'), 'workspace_lock_link_missing');
        assert.equal(posix.normalize(posix.join(entry.path, locked.version.slice(5))), dependency.path, 'workspace_lock_link_mismatch');
        edges.push({ from: entry.path, name, to: dependency.path, group }); pending.push(dependency);
    }
  }
  return { selected: [...selected].sort(), edges, copiedSources: sources, rootBuildInputs, packageNames: [...byName.keys()].sort() };
}

export async function readBuildContextClosure(root) {
  for (const path of rootBuildInputs) {
    try { await readFile(join(root, path)); }
    catch { throw new Error('context_root_build_input_missing'); }
  }
  const manifests = [{ path: '.', manifest: JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) }];
  for (const entry of await readdir(join(root, 'packages'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    manifests.push({ path: `packages/${entry.name}`, manifest: JSON.parse(await readFile(join(root, 'packages', entry.name, 'package.json'), 'utf8')) });
  }
  return assertBuildContextClosure(manifests, await readFile(join(root, 'pnpm-lock.yaml'), 'utf8'),
    await readFile(join(root, 'packages/projection-service/Dockerfile'), 'utf8'));
}
