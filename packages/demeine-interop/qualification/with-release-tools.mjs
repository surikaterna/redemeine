import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { delimiter, dirname, isAbsolute } from 'node:path';
import { pins } from '../../../scripts/release/workspace.mjs';

const [npmExecutable, command, ...args] = process.argv.slice(2);
assert(npmExecutable && isAbsolute(npmExecutable) && command,
  'Usage: node with-release-tools.mjs /absolute/path/to/npm COMMAND [ARGS...]');
assert.equal(process.versions.node, pins.node);
const env = { ...process.env, PATH: [dirname(npmExecutable), dirname(process.execPath), process.env.PATH].join(delimiter) };
const version = (tool, args) => execFileSync(tool, args, { env, encoding: 'utf8' }).trim();
assert.equal(version(npmExecutable, ['--version']), pins.npm);
assert.equal(version('npm', ['--version']), pins.npm);
assert.equal(version('pnpm', ['--version']), pins.pnpm);
const probe = 'require("node:child_process").execFileSync("npm", ["--version"], {encoding:"utf8"}).trim()';
const nestedNode = version(process.execPath, ['-p', probe]);
const nestedPnpm = version('pnpm', ['--config.verify-deps-before-run=false', 'exec', 'node', '-p', probe]);
assert.equal(nestedNode, pins.npm);
assert.equal(nestedPnpm, pins.npm);
console.log(JSON.stringify({ pins, npmExecutable, npmRealpath: realpathSync(npmExecutable), nestedNode, nestedPnpm }));
execFileSync(command, args, { env, stdio: 'inherit' });
