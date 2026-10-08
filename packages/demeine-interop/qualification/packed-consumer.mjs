import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const output = resolve(root, '.cache/demeine-interop');
const consumer = resolve(output, 'consumer');
const tool = resolve(output, 'cli-tool');
const inventory = JSON.parse(await readFile(resolve(output, 'inventory.json'))).inventory;
const tarball = name => inventory.find(item => item.path.split('/').pop().startsWith(`redemeine-${name}-`)).path;
const run = (command, args, cwd = consumer) => execFileSync(command, args, { cwd, stdio: 'inherit' });

await rm(consumer, { recursive: true, force: true });
await mkdir(consumer, { recursive: true });
await writeFile(resolve(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies: {
  '@redemeine/kernel': `file:${tarball('kernel')}`,
  '@redemeine/aggregate': `file:${tarball('aggregate')}`,
  '@redemeine/demeine-interop': `file:${tarball('demeine-interop')}`,
  demeine: '1.3.0', 'regenerator-runtime': '0.13.11', zod: '4.3.6',
}, devDependencies: { typescript: '5.9.3', '@types/node': '24.13.2', '@types/bluebird': '3.5.42' } }, null, 2));
run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund']);
const source = resolve(root, 'packages/demeine-interop/qualification/consumer.ts');
await copyFile(source, resolve(consumer, 'consumer.cts'));
// demeine's CJS barrel is marked __esModule without a default export. Native ESM
// uses the module default; transpiled CJS uses its real named property instead.
const esm = (await readFile(source, 'utf8')).replace(
  "import { Aggregate, type CommandSink } from 'demeine';",
  "import legacy from 'demeine';\nimport type { CommandSink } from 'demeine';\nconst { Aggregate } = legacy;",
);
await writeFile(resolve(consumer, 'consumer.mts'), esm);
run('node', ['node_modules/typescript/bin/tsc', '--strict', '--skipLibCheck', 'false', '--target', 'es2022', '--module', 'nodenext', '--moduleResolution', 'nodenext', '--esModuleInterop', 'true', '--outDir', 'compiled', 'consumer.mts', 'consumer.cts']);
for (const version of ['24.20.0', '26.10.0']) {
  for (const format of ['mjs', 'cjs']) run('mise', ['exec', `node@${version}`, '--', 'node', '--unhandled-rejections=strict', '--no-experimental-require-module', `compiled/consumer.${format}`]);
}
const rejectionFixture = (await readFile(resolve(root, 'packages/demeine-interop/test/syncRejection.fixture.mjs'), 'utf8'))
  .replace('../../aggregate/src/index.ts', '@redemeine/aggregate')
  .replace('../src/createDemeineBridge.ts', '@redemeine/demeine-interop');
await writeFile(resolve(consumer, 'syncRejection.mjs'), rejectionFixture);
for (const boundary of ['eventHandler', 'envelope', 'process', 'apply']) {
  for (const failure of ['promise', 'thenable', 'delayed', 'getter', 'throw', 'callable']) {
    run('node', ['--unhandled-rejections=strict', '--no-experimental-require-module', 'syncRejection.mjs', boundary, failure]);
  }
}
const manifest = JSON.parse(await readFile(resolve(consumer, 'node_modules/@redemeine/demeine-interop/package.json')));
assert.deepEqual(Object.keys(manifest.dependencies), ['@redemeine/kernel']);
for (const name of ['kernel', 'aggregate', 'demeine-interop']) {
  const path = resolve(consumer, 'node_modules/@redemeine', name);
  const pkg = JSON.parse(await readFile(resolve(path, 'package.json')));
  assert.equal(pkg.exports['.'].require.default, './dist/index.cjs');
  assert.equal(pkg.exports['.'].require.types, './dist/index.d.cts');
}
await assert.rejects(access(resolve(consumer, 'node_modules/@redemeine/mirage')));
for (const format of ['js', 'cjs']) {
  const map = JSON.parse(await readFile(resolve(consumer, `node_modules/@redemeine/demeine-interop/dist/index.${format}.map`)));
  assert(map.sources.every(source => source.startsWith('../src/')), 'Interop must not bundle another runtime');
}
const mirage = await import(pathToFileURL(resolve(output, 'candidate/packages/mirage/dist/index.js')).href);
assert(!('createDemeineBridge' in mirage), 'Mirage must not re-export the old bridge');

await mkdir(tool, { recursive: true });
await writeFile(resolve(tool, 'package.json'), JSON.stringify({ private: true, dependencies: { '@redemeine/cli': `file:${tarball('cli')}` } }));
run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], tool);
const cliRoot = resolve(tool, 'node_modules/@redemeine/cli');
const cli = JSON.parse(await readFile(resolve(cliRoot, 'package.json')));
assert.equal(cli.version, '0.2.0-pre.0');
run('node', [resolve(cliRoot, cli.bin.redemeine), '--help'], tool);
console.log('REDEMEINE_CLI_DIR=' + cliRoot);
