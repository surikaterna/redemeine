import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
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
  const aliases = await readFile(resolve(consumer, `aliases.${extension}`), 'utf8');
  await writeFile(resolve(consumer, `missing-property.${extension}`),
    aliases.replace('// @ts-expect-error widened command keys cannot promise a fabricated alias', ''));
  await copyFile(resolve(root, 'packages/demeine-interop/test/typefixtures/spread.mts'), resolve(consumer, `spread.${extension}`));
  const keys = await readFile(resolve(root, 'packages/demeine-interop/test/typefixtures/aliasKeys.mts'), 'utf8');
  await writeFile(resolve(consumer, `aliasKeys.${extension}`), keys);
  await writeFile(resolve(consumer, `missing-patterns.${extension}`),
    keys.replaceAll('// @ts-expect-error open command key has no guaranteed alias', ''));
}
run('pnpm', ['exec', 'tsc', '--strict', '--exactOptionalPropertyTypes', '--skipLibCheck', 'false', '--types', 'node',
  '--target', 'es2022', '--module', 'nodenext', '--moduleResolution', 'nodenext', '--noEmit', 'aliases.mts', 'aliases.cts', 'aliasKeys.mts', 'aliasKeys.cts']);
for (const [fixture, count] of [['missing-property', 1], ['missing-patterns', 10]]) {
  for (const extension of ['mts', 'cts']) {
    const result = spawnSync('pnpm', ['exec', 'tsc', '--strict', '--exactOptionalPropertyTypes', '--skipLibCheck', 'false', '--types', 'node',
      '--target', 'es2022', '--module', 'nodenext', '--moduleResolution', 'nodenext', '--pretty', 'false', '--noEmit', `${fixture}.${extension}`],
    { cwd: consumer, encoding: 'utf8' });
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.equal(result.stderr, '');
    assert.equal((result.stdout.match(/error TS\d+:/g) ?? []).length, count, result.stdout);
    assert.equal((result.stdout.match(/error TS2339: Property '.*Identifier' does not exist on type/g) ?? []).length, count, result.stdout);
    console.log(result.stdout.trim());
  }
}
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
  }, rename: {
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
      assert.equal(Bridge.prototype.renameIdentifier, Bridge.prototype.identifiersRename);
      const bridge = new Bridge();
      await bridge.registerIdentifier('one', 'alias');
      await bridge.identifiersRegister('one', 'flat');
      await bridge.renameIdentifier('one', 'renamed');
      await bridge.identifiersRename('one', 'renamed-flat');
      await assert.rejects(bridge.renameIdentifier('missing', 'wrong'), /Invalid mounted command target/);
      await assert.rejects(bridge.identifiersRename('missing', 'wrong'), /Invalid mounted command target/);
      await assert.rejects(bridge.renameIdentifier(undefined, 'wrong'), /Invalid mounted command target/);
      await assert.rejects(bridge.identifiersRename(undefined, 'wrong'), /Invalid mounted command target/);
      assert.deepEqual(calls, [['one', 'alias'], ['one', 'flat']]);
      assert.deepEqual(bridge._state.identifiers, [{ id: 'one', value: 'renamed-flat' }]);
      assert.equal(bridge.getVersion(), 4);
      assert.deepEqual(bridge.getUncommittedEvents().map(event => event.type), Array(4).fill(built.types.events.registered));
    }
    await checkDirectLists(aggregate, interop);
    checkExcludedMounts(aggregate, interop, entity);
  }
}
function checkExcludedMounts(aggregate, interop, entity) {
  const parent = aggregate.createEntity('parent', { children: [] }).entityList('children', entity).build();
  const host = aggregate.createAggregate('excluded', { lookup: {}, parents: [] })
    .entityMap('lookup', entity).entityList('parents', parent).build();
  const bridge = new (interop.createDemeineBridge(host))();
  for (const name of ['registerIdentifier', 'renameIdentifier', 'childrenRegisterParent', 'childrenRenameParent', 'lookup', 'parents']) {
    assert.equal(bridge[name], undefined);
  }
  for (const name of ['lookupRegister', 'lookupRename', 'parentsChildrenRegister', 'parentsChildrenRename']) {
    assert.equal(typeof bridge[name], 'function');
  }
}
async function checkDirectLists(aggregate, interop) {
  const row = aggregate.createEntity('row', { id: '', qty: 0 })
    .events({ changed(state, event) { state.qty = event.payload.qty; } })
    .commands(emit => ({ set(state, payload) { return emit.changed({ ...payload, qty: state.qty + 1 }); } })).build();
  const line = aggregate.createEntity('line', { id: '', qty: 0 })
    .events({ changed(state, event) { state.qty = event.payload.qty; } })
    .commands(emit => ({ set: { pack: (id, qty) => ({ id, qty }),
      handler(state, payload) { return emit.changed({ id: payload.id, qty: state.qty + payload.qty }); } } })).build();
  const parent = aggregate.createEntity('parent', { children: [] }).entityList('children', row).build();
  const host = aggregate.createAggregate('order', { rows: [{ id: 'a', qty: 2 }], lines: [{ id: 'a', qty: 2 }], parents: [] })
    .entityList('rows', row).entityList('lines', line).entityList('parents', parent).build();
  const bridge = new (interop.createDemeineBridge(host))();
  assert.equal(bridge.setRow, bridge.rowsSet);
  assert.equal(bridge.setLine, bridge.linesSet);
  await bridge.setRow({ id: 'a' });
  await bridge.setLine('a', 3);
  assert.deepEqual(bridge._state.rows, [{ id: 'a', qty: 3 }]);
  assert.deepEqual(bridge._state.lines, [{ id: 'a', qty: 5 }]);
  for (const method of [bridge.setRow, bridge.rowsSet]) {
    for (const payload of [{}, { id: 'missing' }]) {
      await assert.rejects(method.call(bridge, payload), /Invalid mounted command target/);
    }
  }
  assert.equal(bridge.getVersion(), 2);
  assert.equal(bridge._state.rows.length, 1);
  for (const name of ['childrenSetParent', 'setParent', 'rows']) assert.equal(bridge[name], undefined);
  const mapped = aggregate.createAggregate('map', { lookup: {} }).entityMap('lookup', row).build();
  assert.equal(new (interop.createDemeineBridge(mapped))().setRow, undefined);
  const overridden = aggregate.createAggregate('override', { rows: [{ id: 'a', qty: 2 }] })
    .entityList('rows', row, {}, { semanticName: 'credential', commandNameOverrides: { set: 'CUSTOM.WIRE.set' } }).build();
  const custom = new (interop.createDemeineBridge(overridden))();
  assert.equal(custom.setCredential, custom.rowsSet);
  assert.equal(custom.setRow, undefined);
  await custom.setCredential({ id: 'a' });
  assert.equal(custom._state.rows[0].qty, 3);
  const collision = aggregate.createAggregate('collision', { rows: [] }).commands(() => ({ setRow: () => [] }))
    .entityList('rows', row).overrideCommandNames({ setRow: 'custom.root.command' }).build();
  assert.throws(() => interop.createDemeineBridge(collision), /Legacy method collision: setRow/);
}
`);
run('node', ['--unhandled-rejections=strict', 'cross-format.mjs']);
console.log('Fresh packed ESM/CJS declarations, spread/assign regressions, negative types and four cross-format runtime combinations passed:', output);
