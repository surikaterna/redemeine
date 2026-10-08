import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, webcrypto } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const [artifactDirectory, factoryTypes, outputDirectory, nodeTypesVersion = '24.13.2'] = process.argv.slice(2);
assert(artifactDirectory && factoryTypes && outputDirectory, 'Usage: standalone-packed.mjs ARTIFACT_DIR ACTUAL_FACTORY_TYPES FRESH_OUTPUT_DIR [HOST_NODE_TYPES]');
const output = resolve(outputDirectory);
await mkdir(output);
const consumer = resolve(output, 'consumer');
await mkdir(consumer);
const plan = JSON.parse(await readFile(resolve(artifactDirectory, 'plan.json')));
assert.equal(plan.artifacts.length, 1);
const artifact = plan.artifacts[0];
assert.equal(artifact.manifest.name, '@redemeine/demeine-interop');
const tarball = resolve(artifactDirectory, artifact.file);
assert.equal(createHash('sha256').update(await readFile(tarball)).digest('hex'), artifact.sha256);
const gates = [];
async function run(label, command, args) {
  const result = spawnSync(command, args, { cwd: consumer, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 180000 });
  await writeFile(resolve(output, `${label}.log`), (result.stdout ?? '') + (result.stderr ?? ''));
  gates.push({ command: [command, ...args], cwd: consumer, status: result.status, log: `${label}.log` });
  await writeFile(resolve(output, 'gates.json'), JSON.stringify(gates, null, 2) + '\n');
  console.log(label, result.status);
  assert.equal(result.status, 0, `See ${label}.log`);
}
await run('minimal-types', 'node', [resolve(root, 'packages/demeine-interop/qualification/minimal-types.mjs'), tarball, resolve(output, 'minimal')]);
await writeFile(resolve(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies: {
  '@redemeine/kernel': '0.2.0-pre.2', '@redemeine/aggregate': '0.2.0-pre.2', '@redemeine/demeine-interop': `file:${tarball}`,
  demeine: '1.3.0', 'regenerator-runtime': '0.13.11', zod: '4.3.6', bluebird: '3.7.2', tapeworm: '0.5.0',
}, devDependencies: {
  typescript: '5.9.3', typescript7: 'npm:typescript@7.0.2', '@types/node': nodeTypesVersion, '@types/bluebird': '3.5.42',
  '@types/jest': '29.5.14', jest: '29.7.0', 'ts-jest': '29.4.11', tsx: '4.21.0', esbuild: '0.25.12',
} }, null, 2));
await run('install', 'npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund']);
const ts = (await import(pathToFileURL(resolve(consumer, 'node_modules/typescript/lib/typescript.js')).href)).default;
const permitted = spec => !/^(?:demeine(?:\/|$)|@redemeine\/mirage(?:\/|$)|node:events$)/.test(spec);
function scanImports(text, filename) {
  const source = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true);
  function visit(node) {
    let spec;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) spec = node.moduleSpecifier?.text;
    if (ts.isImportTypeNode(node)) spec = node.argument.literal?.text;
    if (ts.isImportEqualsDeclaration(node)) spec = node.moduleReference.expression?.text;
    if (ts.isCallExpression(node) && (node.expression.text === 'require' || node.expression.kind === ts.SyntaxKind.ImportKeyword)) spec = node.arguments[0]?.text;
    if (spec) assert(permitted(spec), `Forbidden production import ${spec} in ${filename}`);
    ts.forEachChild(node, visit);
  }
  visit(source);
}
const interopRoot = resolve(consumer, 'node_modules/@redemeine/demeine-interop');
for (const file of await readdir(resolve(root, 'packages/demeine-interop/src'))) {
  scanImports(await readFile(resolve(root, 'packages/demeine-interop/src', file), 'utf8'), file);
}
for (const file of ['index.js', 'index.cjs', 'index.d.ts', 'index.d.cts']) {
  const text = await readFile(resolve(interopRoot, 'dist', file), 'utf8');
  if (file.includes('.d.')) assert(text.startsWith('/// <reference types="node" />'));
  scanImports(text, file);
}
for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) assert(Object.keys(artifact.manifest[field] ?? {}).every(permitted));
for (const format of ['js', 'cjs']) {
  const map = JSON.parse(await readFile(resolve(interopRoot, `dist/index.${format}.map`)));
  for (const [index, source] of map.sources.entries()) {
    assert(source.startsWith('../src/'));
    assert.equal(map.sourcesContent[index], await readFile(resolve(root, 'packages/demeine-interop', source.slice(3)), 'utf8'));
  }
}
assert.equal(await readFile(resolve(interopRoot, 'README.md'), 'utf8'), await readFile(resolve(root, 'packages/demeine-interop/README.md'), 'utf8'));
await writeFile(resolve(output, 'boundary.json'), JSON.stringify({ productionImportsPassed: true, sourceMapsMatch: true, readmeMatches: true,
  factoryTypes: resolve(factoryTypes), factorySha256: createHash('sha256').update(await readFile(factoryTypes)).digest('hex'),
}, null, 2));
for (const name of ['consumer', 'legacy-types', 'state-services']) {
  const source = await readFile(resolve(root, `packages/demeine-interop/qualification/${name}.ts`));
  for (const extension of ['mts', 'cts']) await writeFile(resolve(consumer, `${name}.${extension}`), source);
}
await writeFile(resolve(consumer, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
  strict: true, skipLibCheck: false, target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext',
  esModuleInterop: true, outDir: 'compiled', paths: { '@surikat/factory/lib/types': [resolve(factoryTypes)] },
}, include: ['*.mts', '*.cts'] }, null, 2));
await run('types-5.9.3', 'node', ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json']);
await run('types-7.0.2', 'node', ['node_modules/typescript7/bin/tsc', '-p', 'tsconfig.json']);
for (const version of ['24.20.0', '26.10.0']) {
  for (const format of ['mjs', 'cjs']) {
    for (const fixture of ['consumer', 'state-services']) await run(`runtime-${fixture}-${version}-${format}`, 'mise', [
      'exec', `node@${version}`, '--', 'node', '--unhandled-rejections=strict', '--no-experimental-require-module', `compiled/${fixture}.${format}`,
    ]);
  }
}
await mkdir(resolve(consumer, 'test'));
for (const file of await readdir(resolve(root, 'packages/demeine-interop/test'))) {
  const text = await readFile(resolve(root, 'packages/demeine-interop/test', file), 'utf8');
  await writeFile(resolve(consumer, 'test', file), text.replaceAll("'../src'", "'@redemeine/demeine-interop'")
    .replaceAll("'../src/createDemeineBridge.ts'", "'@redemeine/demeine-interop'")
    .replaceAll("'../../aggregate/src/index.ts'", "'@redemeine/aggregate'"));
}
await writeFile(resolve(consumer, 'test/package.json'), JSON.stringify({ type: 'commonjs' }));
await writeFile(resolve(consumer, 'jest.config.cjs'), `module.exports = {
  testEnvironment: 'node', roots: ['<rootDir>/test'],
  transform: { '^.+\\.tsx?$': ['ts-jest', { tsconfig: {
    module: 'Node16', moduleResolution: 'Node16', target: 'ES2022', strict: true, esModuleInterop: true, isolatedModules: true
  } }] }
};\n`);
await run('packed-tests', 'node', ['--unhandled-rejections=strict', '--no-experimental-require-module', 'node_modules/jest/bin/jest.js', '--config', 'jest.config.cjs', '--runInBand']);
for (const version of ['24.20.0', '26.10.0']) {
  for (const kind of ['native', 'realm', 'bluebird', 'thenable', 'getter', 'throwing-then']) {
    const timings = ['getter', 'throwing-then'].includes(kind) ? ['immediate'] : ['immediate', 'delayed'];
    for (const timing of timings) await run(`queued-${version}-${kind}-${timing}`, 'mise', [
      'exec', `node@${version}`, '--', 'node', '--unhandled-rejections=strict', '--no-experimental-require-module',
      'test/queueRejection.fixture.mjs', kind, timing,
    ]);
  }
}
await writeFile(resolve(consumer, 'browser.mjs'), await readFile(resolve(root, 'packages/demeine-interop/qualification/browser.mjs')));
await run('browser-build', 'node', ['node_modules/esbuild/bin/esbuild', 'browser.mjs', '--bundle', '--platform=browser', '--format=iife', '--outfile=browser.js', '--metafile=browser-meta.json']);
const inputs = Object.keys(JSON.parse(await readFile(resolve(consumer, 'browser-meta.json'))).inputs);
assert(inputs.some(file => file.endsWith('node_modules/events/events.js')));
assert(!inputs.some(file => /(?:^node:|node_modules\/(?:demeine|@redemeine\/mirage)\/)/.test(file)));
const browser = { crypto: webcrypto, structuredClone, setTimeout, clearTimeout, console };
runInNewContext(await readFile(resolve(consumer, 'browser.js'), 'utf8'), browser);
assert.equal((await browser.browserSmoke).count, 2);
await writeFile(resolve(output, 'browser.json'), JSON.stringify({ passed: true, inputs }, null, 2));
const lock = JSON.parse(await readFile(resolve(consumer, 'package-lock.json')));
const installed = ['@redemeine/kernel', '@redemeine/aggregate', '@redemeine/demeine-interop', '@types/node', 'p-queue', 'events', 'bluebird', 'uuid'].map(name => ({ name, ...lock.packages[`node_modules/${name}`] }));
for (const entry of installed) {
  if (entry.name === '@redemeine/demeine-interop') assert.equal(entry.integrity, artifact.integrity);
  else assert.match(entry.resolved, /^https:\/\/registry\.npmjs\.org\//);
}
await writeFile(resolve(output, 'installed.json'), JSON.stringify(installed, null, 2));
console.log('Packed standalone types, runtime, lifecycle and browser gates passed');
