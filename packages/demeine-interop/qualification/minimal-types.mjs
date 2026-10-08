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
async function run(label, args, expectTypeErrors = false) {
  const [command, ...parameters] = args;
  const result = spawnSync(command, parameters, { cwd: output, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 180000 });
  await writeFile(resolve(output, `${label}.log`), (result.stdout ?? '') + (result.stderr ?? ''));
  gates.push({ command: args, cwd: output, status: result.status, expectTypeErrors, log: `${label}.log` });
  await writeFile(resolve(output, 'gates.json'), JSON.stringify(gates, null, 2));
  console.log(label, result.status);
  if (expectTypeErrors) assert(result.status > 0, `Expected rejection: ${label}.log`);
  else assert.equal(result.status, 0, `See ${label}.log`);
  return result.stdout;
}
await run('install', ['npm', 'install', '--ignore-scripts', '--no-audit', '--no-fund']);
const source = `import { Queue, createDemeineBridge, type CompatibleAggregate, type CompatibleAggregateConstructor,
  type CommandSink, type CommandHandler, type EventHandler } from '@redemeine/demeine-interop';
const queue = new Queue();
queue.once('probe', (value: number) => { void value; });
queue.once(Symbol('probe'), () => {});
const names: (string | symbol)[] = queue.eventNames();
export const Counter = createDemeineBridge({
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
type State = { count: number };
const events: EventHandler<State> = { handle(aggregate, event) {
  aggregate._state.count++;
  const link: unknown = event.metadata?.command;
  const trace: unknown = event.headers?.trace;
  void link; void trace;
} };
const commands: CommandHandler<State> = { handle(aggregate, command) {
  aggregate._state.count++;
  const trace: unknown = command.headers?.trace;
  const origin: unknown = command.metadata?.origin;
  void trace; void origin;
  return aggregate;
} };
const sink: CommandSink<State> = { sink(command, aggregate) {
  const trace: unknown = command.headers?.trace;
  const origin: unknown = command.metadata?.origin;
  void trace; void origin;
  return aggregate._process(command);
} };
export const Base: CompatibleAggregateConstructor<State> = Counter;
new Counter(sink, events, commands);
new Base(sink, events, commands);
new Counter(undefined, { handle(aggregate) { aggregate._state.count++; } }, { handle(aggregate) { aggregate._state.count++; return aggregate; } });
new Base(undefined, { handle(aggregate) { aggregate._state.count++; } }, { handle(aggregate) { aggregate._state.count++; return aggregate; } });
void counter._sink({ type: 'counter.increment.command', payload: {}, headers: { trace: 1 }, metadata: { origin: 'caller' } });
counter._apply({ type: 'counter.incremented.event', payload: {}, headers: { trace: 1 }, metadata: { command: { id: 'caller' } } });
`;
for (const extension of ['mts', 'cts']) await writeFile(resolve(output, `consumer.${extension}`), source);
for (const [extension, runtime] of [['mts', 'mjs'], ['cts', 'cjs']]) await writeFile(resolve(output, `negative.${extension}`), `
import { Counter, Base } from './consumer.${runtime}';
import { createDemeineBridge, type CommandHandler } from '@redemeine/demeine-interop';
const Other = createDemeineBridge({ initialState: { label: '' }, types: { commands: {}, events: {} }, commandCreators: {}, process: () => [], apply: state => state });
const counter = new Counter();
counter._eventHandler.handle(new Other(), { type: 'event', payload: {} });
counter._commandHandler.handle(new Other(), { type: 'command', payload: {} });
const wrong: CommandHandler<{ label: string }> = { handle(aggregate) { aggregate._state.label.toUpperCase(); return aggregate; } };
new Counter(undefined, undefined, wrong);
new Base(undefined, undefined, wrong);
`);
const resolutions = [['NodeNext', 'NodeNext'], ['Preserve', 'Bundler']];
const loaded = [];
for (const [module, moduleResolution] of resolutions) {
  const config = { compilerOptions: {
    strict: true, skipLibCheck: false, noEmit: true, target: 'ES2022', lib: ['ES2022', 'DOM'],
    module, moduleResolution, esModuleInterop: true, types: [], typeRoots: [],
  }, files: ['consumer.mts', 'consumer.cts'] };
  const filename = `tsconfig-${moduleResolution}.json`;
  await writeFile(resolve(output, filename), JSON.stringify(config, null, 2));
  const negativeConfig = `negative-${moduleResolution}.json`;
  await writeFile(resolve(output, negativeConfig), JSON.stringify({ ...config, files: ['negative.mts', 'negative.cts'] }, null, 2));
  for (const compiler of ['typescript', 'typescript7']) {
    const stdout = await run(`${compiler}-${moduleResolution}`, ['node', `node_modules/${compiler}/bin/tsc`, '-p', filename, '--listFiles']);
    const files = stdout.trim().split('\n');
    for (const file of files) {
      assert(isAbsolute(file), `Unexpected compiler output: ${file}`);
      const location = relative(output, await realpath(file));
      assert(!location.startsWith('..') && !isAbsolute(location), `Ancestor dependency leaked into minimal fixture: ${file}`);
    }
    loaded.push({ compiler, moduleResolution, files });
    const rejected = await run(`${compiler}-${moduleResolution}-wrong-state`, ['node', `node_modules/${compiler}/bin/tsc`, '-p', negativeConfig], true);
    const diagnostics = [...rejected.matchAll(/^negative\.(?:mts|cts)\(\d+,\d+\): error TS(\d+):/gm)];
    assert.equal(diagnostics.length, 8, rejected);
    assert.equal((rejected.match(/error TS/g) ?? []).length, 8, rejected);
    assert.deepEqual(diagnostics.map(match => match[1]).sort(), ['2345', '2345', '2345', '2345', '2769', '2769', '2769', '2769']);
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
