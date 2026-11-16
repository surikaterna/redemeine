import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const fixtures = fileURLToPath(new URL('./packed-consumer/', import.meta.url));
const parent = '/tmp/opencode';
mkdirSync(parent, { recursive: true });
const output = mkdtempSync(join(parent, 'projection-packed-'));
const consumer = join(output, 'consumer');
mkdirSync(consumer);
const env = { ...process.env, NODE_PATH: '', npm_config_cache: join(output, 'cache') };

function command(program, args, cwd = consumer) {
  console.log(program, args.join(' '), `(cwd=${cwd})`);
  return execFileSync(program, args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function pack(name) {
  const packed = JSON.parse(
    command(
      'pnpm',
      ['--config.ignore-scripts=true', '--config.ignore-pnpmfile=true', 'pack', '--json', '--pack-destination', output],
      join(repo, 'packages', name)
    )
  );
  if (name === 'projection') {
    for (const path of ['dist/index.js', 'dist/index.cjs', 'dist/index.d.ts', 'dist/index.d.cts']) {
      assert(
        packed.files.some((file) => file.path === path),
        `Missing packed ${path}`
      );
    }
    assert(packed.files.every((file) => !file.path.startsWith('src/')));
  }
  return resolve(output, packed.filename);
}

const tarballs = { projection: pack('projection') };
const dependencies = Object.fromEntries(Object.entries(tarballs).map(([name, path]) => [`@redemeine/${name}`, `file:${path}`]));
const compilerVersion = JSON.parse(readFileSync(join(repo, 'node_modules/typescript/package.json'), 'utf8')).version;
writeFileSync(
  join(consumer, 'package.json'),
  JSON.stringify({
    private: true,
    type: 'module',
    dependencies,
    devDependencies: { typescript: compilerVersion }
  })
);
console.log(command('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund']));
for (const name of Object.keys(tarballs)) {
  assert(realpathSync(join(consumer, 'node_modules/@redemeine', name)).startsWith(`${consumer}/`));
}
copyFileSync(join(fixtures, 'runtime.mjs'), join(consumer, 'runtime.mjs'));
console.log(command(process.execPath, ['runtime.mjs']));
for (const extension of ['mts', 'cts']) {
  copyFileSync(join(fixtures, 'input.mts'), join(consumer, `input.${extension}`));
}
writeFileSync(
  join(consumer, 'tsconfig.json'),
  JSON.stringify({
    compilerOptions: {
      strict: true,
      skipLibCheck: false,
      noEmit: true,
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      types: [],
      typeRoots: [],
      exactOptionalPropertyTypes: true,
      noUncheckedIndexedAccess: true
    },
    files: ['input.mts', 'input.cts']
  })
);
const files = command(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json', '--listFiles']);
for (const file of files.trim().split('\n')) {
  assert(file.startsWith(`${consumer}/`), `Non-isolated type resolution: ${file}`);
}
for (const declaration of ['index.d.ts', 'index.d.cts']) {
  assert(files.includes(`/@redemeine/projection/dist/${declaration}`), `Declaration not checked: ${declaration}`);
}
console.log(`Packed projection ESM/CJS runtime and strict declarations passed. Evidence: ${output}`);
