import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runtimeCommands } from '../consumer-runtime/smoke-commands.mjs';
import { smokePlan } from '../consumer-smokes.mjs';
import { hash } from '../workspace.mjs';

// Captured from the pre-F1 executor before extraction, not from the expected-command builder.
const originals = [
  ['@fixture/app', '2f95a3eac0d4c54f7679cf2268d60fd38dc5b09f9b2764e28aa8902be2c45362', 8],
  ['@redemeine/kernel', '2535ab21fa67e9d0b503961d833a92a4cd3636ef87fb1202240d76a04712f2ce', 9],
  ['@redemeine/cli', '83b53b4f3f25c34eee584f32cb3dbfbcbb2b5d3509d954e2ed9ffa3d7fa30ad2', 10]
];

for (const [name, sha256, count] of originals)
  test(`F1 preserves original ${name} runtime argv/payload bytes across modes and surfaces`, () => {
    const manifest = {
      name,
      version: '1.0.0',
      types: './dist/index.d.ts',
      exports: {
        '.': { import: './dist/index.js', require: './dist/index.cjs' },
        './extra': './dist/extra.cjs',
        './import-only': { import: './dist/only.js', require: null },
        './quoted"key': './dist/extra.cjs'
      }
    };
    const commands = runtimeCommands(smokePlan({ manifest }));
    assert.equal(commands.length, count);
    assert.equal(hash(JSON.stringify(commands)), sha256);
    assert(commands.some((item) => item.args.includes('--input-type=module')));
    assert(commands.some((item) => item.args[0] === '-e'));
    assert(commands.some((item) => item.args.at(-1).includes('ERR_PACKAGE_PATH_NOT_EXPORTED')));
  });
