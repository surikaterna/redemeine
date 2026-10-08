import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

const [tarballArgument, outputArgument] = process.argv.slice(2);
assert(tarballArgument && outputArgument, 'Usage: minimal-types.mjs TARBALL FRESH_OUTPUT_DIRECTORY');
const tarball = resolve(tarballArgument);
const output = resolve(outputArgument);
await mkdir(output);
const manifest = { private: true, type: 'module', dependencies: {
  '@redemeine/demeine-interop': `file:${tarball}`,
}, devDependencies: { typescript: '5.9.3', typescript7: 'npm:typescript@7.0.2' } };
await writeFile(resolve(output, 'package.json'), JSON.stringify(manifest, null, 2));
const gates = [];
async function run(label, args) {
  const [command, ...parameters] = args;
  const result = spawnSync(command, parameters, { cwd: output, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 180000 });
  await writeFile(resolve(output, `${label}.log`), (result.stdout ?? '') + (result.stderr ?? ''));
  gates.push({ command: args, cwd: output, status: result.status, log: `${label}.log` });
  await writeFile(resolve(output, 'gates.json'), JSON.stringify(gates, null, 2));
  console.log(label, result.status);
  assert.equal(result.status, 0, `See ${label}.log`);
  return result.stdout;
}
await run('install', ['npm', 'install', '--ignore-scripts', '--no-audit', '--no-fund']);
const source = `import { Queue, createDemeineBridge, type CompatibleAggregate } from '@redemeine/demeine-interop';
const queue = new Queue();
queue.once('probe', (value: number) => { void value; });
queue.once(Symbol('probe'), () => {});
const names: (string | symbol)[] = queue.eventNames();
const Counter = createDemeineBridge({
  initialState: { count: 0 }, aggregateType: 'counter',
  types: { commands: { increment: 'counter.increment.command' }, events: { incremented: 'counter.incremented.event' } },
  commandCreators: { increment: () => ({ type: 'counter.increment.command', payload: {} }) },
  process: () => [{ type: 'counter.incremented.event', payload: {} }],
  apply: (state: { count: number }) => ({ count: state.count + 1 }),
});
const counter = new Counter();
const result: Promise<CompatibleAggregate<{ count: number }> | true> = counter.increment();
void result;
void names;
`;
for (const extension of ['mts', 'cts']) await writeFile(resolve(output, `consumer.${extension}`), source);
const resolutions = [['NodeNext', 'NodeNext'], ['Preserve', 'Bundler']];
const loaded = [];
for (const [module, moduleResolution] of resolutions) {
  const config = { compilerOptions: {
    strict: true, skipLibCheck: false, noEmit: true, target: 'ES2022', lib: ['ES2022', 'DOM'],
    module, moduleResolution, esModuleInterop: true, types: [], typeRoots: [],
  }, files: ['consumer.mts', 'consumer.cts'] };
  const filename = `tsconfig-${moduleResolution}.json`;
  await writeFile(resolve(output, filename), JSON.stringify(config, null, 2));
  for (const compiler of ['typescript', 'typescript7']) {
    const stdout = await run(`${compiler}-${moduleResolution}`, ['node', `node_modules/${compiler}/bin/tsc`, '-p', filename, '--listFiles']);
    const files = stdout.trim().split('\n');
    for (const file of files) {
      assert(isAbsolute(file), `Unexpected compiler output: ${file}`);
      const location = relative(output, await realpath(file));
      assert(!location.startsWith('..') && !isAbsolute(location), `Ancestor dependency leaked into minimal fixture: ${file}`);
    }
    loaded.push({ compiler, moduleResolution, files });
  }
}
const lock = JSON.parse(await readFile(resolve(output, 'package-lock.json')));
assert.deepEqual(lock.packages[''].dependencies, manifest.dependencies);
assert.deepEqual(lock.packages[''].devDependencies, manifest.devDependencies);
assert(!Object.keys(lock.packages).some(name => /node_modules\/(?:demeine|@surikat\/|@types\/jest|jest(?:\/|$))/.test(name)));
const installedPath = resolve(output, 'node_modules/@redemeine/demeine-interop');
assert(!(await lstat(installedPath)).isSymbolicLink(), 'Candidate must be physically installed');
const installed = JSON.parse(await readFile(resolve(installedPath, 'package.json')));
assert.equal(installed.dependencies['@types/node'], '24.13.2');
await writeFile(resolve(output, 'closure.json'), JSON.stringify({
  tarball, sha256: createHash('sha256').update(await readFile(tarball)).digest('hex'),
  integrity: lock.packages['node_modules/@redemeine/demeine-interop'].integrity,
  installed, loaded, packages: Object.keys(lock.packages),
}, null, 2));
console.log('Physical minimal declaration closure passed without ambient fixture dependencies');
