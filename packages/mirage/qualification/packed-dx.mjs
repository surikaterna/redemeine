import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const output = await mkdtemp(resolve(tmpdir(), 'mirage-dx-packed-'));
const gates = [];
async function run(label, command, args, cwd = output) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
  await writeFile(resolve(output, `${label}.log`), `${result.stdout ?? ''}${result.stderr ?? ''}`);
  gates.push({ label, command: [command, ...args], cwd, status: result.status });
  await writeFile(resolve(output, 'gates.json'), JSON.stringify(gates, null, 2));
  assert.ifError(result.error);
  assert.equal(result.status, 0, `See ${output}/${label}.log`);
  console.log('PASS', label);
  return result.stdout;
}

console.log('Non-publishing packed DX evidence:', output);
const dependencies = { zod: '4.3.6' };
for (const name of ['kernel', 'aggregate', 'mirage']) {
  const directory = resolve(root, 'packages', name);
  const manifest = JSON.parse(await readFile(resolve(directory, 'package.json')));
  const filename = `redemeine-${name}-${manifest.version}.tgz`;
  await run(`pack-${name}`, 'pnpm', ['--config.ignore-scripts=true', '--config.ignore-pnpmfile=true', 'pack', '--pack-destination', output], directory);
  dependencies[manifest.name] = `file:${resolve(output, filename)}`;
}
await writeFile(resolve(output, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies,
  devDependencies: { typescript: '5.9.3', typescript7: 'npm:typescript@7.0.2' } }, null, 2));
await run('install', 'npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund']);
await writeFile(resolve(output, 'consumer.mts'), await readFile(resolve(root, 'packages/mirage/test/dx-contract.types.ts')));
await writeFile(resolve(output, 'scoped.mts'), await readFile(resolve(root, 'packages/mirage/test/scopedCommands.fixture.ts.txt')));
await writeFile(resolve(output, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
  strict: true, skipLibCheck: false, noEmit: true, target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext',
  exactOptionalPropertyTypes: true, noUncheckedIndexedAccess: true, types: [], typeRoots: []
}, files: ['consumer.mts', 'scoped.mts'] }, null, 2));
for (const compiler of ['typescript', 'typescript7']) {
  const stdout = await run(compiler, process.execPath, [`node_modules/${compiler}/bin/tsc`, '-p', 'tsconfig.json', '--listFiles']);
  for (const file of stdout.trim().split('\n')) assert(file.startsWith(`${output}/`), `Ancestor type leaked: ${file}`);
  await run(`${compiler}-emit`, process.execPath, [`node_modules/${compiler}/bin/tsc`, '-p', 'tsconfig.json',
    '--noEmit', 'false', '--declaration', '--emitDeclarationOnly', '--outDir', `emitted-${compiler}`]);
  await writeFile(resolve(output, 'downstream.mts'), `
import { selectedCommandHost } from './emitted-${compiler}/consumer.mjs';
import { createMirage } from '@redemeine/mirage';
import { scopedHost } from './emitted-${compiler}/scoped.mjs';
const scoped = createMirage(scopedHost, 'scoped').rows('');
scoped.optional({ body: 'ok' }); scoped.current({ body: 'ok' }); scoped.replace({ latest: 2 });
scoped.correlated({ kind: 'a', a: 'ok' }); scoped.correlated({ kind: 'b', b: 2 });
createMirage(scopedHost, 'bound').chosen()!.correlated({ kind: 'a', a: 'bound' });
const noAnyCorrelated: 0 extends (1 & Parameters<typeof scoped.correlated>[0]) ? true : false = false;
const noAnyA: 0 extends (1 & Extract<Parameters<typeof scoped.correlated>[0], { kind: 'a' }>['a']) ? true : false = false;
const noAnyB: 0 extends (1 & Extract<Parameters<typeof scoped.correlated>[0], { kind: 'b' }>['b']) ? true : false = false;
// @ts-expect-error branch a business field remains required downstream
scoped.correlated({ kind: 'a' });
// @ts-expect-error branch b business field remains required downstream
scoped.correlated({ kind: 'b' });
// @ts-expect-error branch a cannot accept branch b fields downstream
scoped.correlated({ kind: 'a', b: 2 });
// @ts-expect-error branch b cannot accept branch a fields downstream
scoped.correlated({ kind: 'b', a: 'wrong' });
// @ts-expect-error branch a business type remains checked downstream
scoped.correlated({ kind: 'a', a: 2 });
void [noAnyCorrelated, noAnyA, noAnyB];
// @ts-expect-error old identity is injected even after changing the selection PK
scoped.optional({ id: 0, body: 'no' });
const live = createMirage(selectedCommandHost, 'downstream');
live.lines('one').set({ qty: 1 });
live.lines('one').setQty(2);
const noAny: 0 extends (1 & typeof live.lines) ? true : false = false;
// @ts-expect-error Required business payload survives declaration emission.
live.lines('one').set();
// @ts-expect-error Incorrect business type remains invalid downstream.
live.lines('one').set({ qty: 'bad' });
void noAny;
`);
  await writeFile(resolve(output, 'downstream.json'), JSON.stringify({ extends: './tsconfig.json', files: ['downstream.mts'] }));
  await run(`${compiler}-downstream`, process.execPath, [`node_modules/${compiler}/bin/tsc`, '-p', 'downstream.json']);
}
await writeFile(resolve(output, 'runtime.mjs'), await readFile(resolve(root, 'packages/mirage/qualification/runtime.mjs')));
await run('runtime', process.execPath, ['--unhandled-rejections=strict', 'runtime.mjs']);
await writeFile(resolve(output, 'selected-commands.mjs'), await readFile(resolve(root, 'packages/mirage/qualification/selected-commands.mjs')));
await run('selected-commands', process.execPath, ['--unhandled-rejections=strict', 'selected-commands.mjs']);
console.log('PASS isolated packed Mirage declarations and runtime; local source versions are NOT publication artifacts');
