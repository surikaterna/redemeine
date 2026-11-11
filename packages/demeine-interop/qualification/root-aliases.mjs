import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Fresh packs of actual sources, not a release-versioned or linked workspace snapshot.
const root = fileURLToPath(new URL('../../../', import.meta.url));
const store = execFileSync('pnpm', ['store', 'path'], { cwd: root, encoding: 'utf8' }).trim().replace(/\/v\d+$/, '');
const output = resolve(process.argv[2] ?? '/tmp/opencode/bridgealias/packed');
await mkdir(output); // Refuse to reuse stale artifacts or consumer dependencies.
const artifacts = resolve(output, 'artifacts');
const consumer = resolve(output, 'consumer');
await mkdir(artifacts);
await mkdir(consumer);
const run = (command, args, cwd = consumer) => execFileSync(command, args, { cwd, stdio: 'inherit' });
const dependencies = {};
const inventory = [];
const sha256 = value => createHash('sha256').update(value).digest('hex');
for (const name of ['kernel', 'aggregate', 'demeine-interop']) {
  const directory = resolve(root, 'packages', name);
  run('pnpm', ['build'], directory);
  run('pnpm', ['pack', '--pack-destination', artifacts], directory);
  const filename = (await readdir(artifacts)).find(file => file.startsWith(`redemeine-${name}-`));
  assert(filename);
  const tarball = resolve(artifacts, filename);
  dependencies[`@redemeine/${name}`] = `file:${tarball}`;
  const manifestBytes = execFileSync('tar', ['-xOf', tarball, 'package/package.json']);
  inventory.push({ tarball, sha256: sha256(await readFile(tarball)), manifestSha256: sha256(manifestBytes), manifest: JSON.parse(manifestBytes) });
}
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
await writeFile(resolve(output, 'inventory.json'), JSON.stringify({ base: git(['rev-parse', 'HEAD']), inventory }, null, 2));
const scope = new Set([...git(['diff', '--name-only', 'HEAD']).split('\n'), ...git(['ls-files', '--others', '--exclude-standard']).split('\n')].filter(Boolean));
await writeFile(resolve(output, 'scope.sha256'), (await Promise.all([...scope].sort().map(async file => `${sha256(await readFile(resolve(root, file)))}  ${file}`))).join('\n') + '\n');
await writeFile(resolve(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies,
  devDependencies: { typescript: '5.9.3', '@types/node': '24.13.2' } }, null, 2));
await writeFile(resolve(consumer, 'pnpm-workspace.yaml'), JSON.stringify({ storeDir: store, overrides: {
  ...dependencies, immer: '10.2.0', zod: '4.4.3'
} }, null, 2));
run('pnpm', ['install', '--offline', '--ignore-scripts']);
for (const name of ['kernel', 'aggregate', 'demeine-interop']) {
  const installed = await realpath(resolve(consumer, 'node_modules/@redemeine', name));
  assert(installed.startsWith(consumer + '/'), 'No ancestor/workspace fallback');
}
const manifest = JSON.parse(await readFile(resolve(consumer, 'node_modules/@redemeine/demeine-interop/package.json')));
assert(manifest.dependencies['@redemeine/aggregate']);
assert(!manifest.dependencies['@redemeine/mirage']);
for (const extension of ['js', 'cjs']) {
  const map = JSON.parse(await readFile(resolve(consumer, `node_modules/@redemeine/demeine-interop/dist/index.${extension}.map`)));
  assert(map.sources.every(source => source.startsWith('../src/')), 'Aggregate must stay external to interop');
}
for (const extension of ['mts', 'cts']) {
  await copyFile(resolve(root, 'packages/demeine-interop/test/typefixtures/aliases.mts'), resolve(consumer, `aliases.${extension}`));
  await copyFile(resolve(root, 'packages/demeine-interop/test/typefixtures/spread.mts'), resolve(consumer, `spread.${extension}`));
}
run('pnpm', ['exec', 'tsc', '--strict', '--exactOptionalPropertyTypes', '--skipLibCheck', 'false', '--types', 'node',
  '--target', 'es2022', '--module', 'nodenext', '--moduleResolution', 'nodenext', '--noEmit', 'aliases.mts', 'aliases.cts']);
run('pnpm', ['exec', 'tsc', '--strict', '--exactOptionalPropertyTypes', '--skipLibCheck', 'false', '--types', 'node',
  '--target', 'es2022', '--module', 'nodenext', '--moduleResolution', 'nodenext', '--outDir', 'emitted', 'spread.mts', 'spread.cts']);
for (const extension of ['mjs', 'cjs']) run('node', ['--unhandled-rejections=strict', `emitted/spread.${extension}`]);
await writeFile(resolve(consumer, 'cross-format.mjs'), `
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as esmAggregate from '@redemeine/aggregate';
import * as esmInterop from '@redemeine/demeine-interop';
const require = createRequire(import.meta.url);
const cjsAggregate = require('@redemeine/aggregate');
const cjsInterop = require('@redemeine/demeine-interop');
for (const aggregate of [esmAggregate, cjsAggregate]) {
  const entity = aggregate.createEntity('identifier', { id: '', value: '' }).events({
    registered(state, event) { Object.assign(state, event.payload); }
  }).commands(emit => ({ register: {
    pack: (id, value) => ({ id, value }), handler: (_, payload) => emit.registered(payload)
  } }), { static: ['register'] }).build();
  const built = aggregate.createAggregate('registry', { identifiers: [] }).entityList('identifiers', entity).build();
  const decorated = built.withPlugins(aggregate.createAggregatePlugin('audit').state(() => ({ count: 0 })).build());
  for (const interop of [esmInterop, cjsInterop]) {
    for (const definition of [built, { ...built }, Object.assign({}, built), { ...decorated }, Object.assign({}, decorated)]) {
      assert.equal(aggregate.commandMetadata(definition, 'identifiersRegister'), aggregate.commandMetadata(built, 'identifiersRegister'));
      const calls = [];
      const replacement = (id, value) => {
        calls.push([id, value]);
        return definition.commandCreators.identifiersRegister(id, value.toUpperCase());
      };
      const input = { ...definition, commandCreators: { ...definition.commandCreators, identifiersRegister: replacement } };
      const Bridge = interop.createDemeineBridge(input);
      assert.equal(Bridge.prototype.registerIdentifier, Bridge.prototype.identifiersRegister);
      const bridge = new Bridge();
      await bridge.registerIdentifier('one', 'alias');
      await bridge.identifiersRegister('one', 'flat');
      assert.deepEqual(calls, [['one', 'alias'], ['one', 'flat']]);
      assert.deepEqual(bridge._state.identifiers, [{ id: 'one', value: 'FLAT' }]);
      assert.equal(bridge.getVersion(), 2);
      assert.deepEqual(bridge.getUncommittedEvents().map(event => event.type), [built.types.events.registered, built.types.events.registered]);
    }
  }
}
`);
run('node', ['--unhandled-rejections=strict', 'cross-format.mjs']);
console.log('Fresh packed ESM/CJS declarations, spread/assign regressions, negative types and four cross-format runtime combinations passed:', output);
