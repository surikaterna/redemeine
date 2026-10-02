import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initAggregate } from '../src/scaffold/initAggregate';
import { addEntity } from '../src/scaffold/addEntity';
import { validName } from '../src/scaffold/paths';
import { confirmInstall, runInstall, preflight } from '../src/scaffold/preflight';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import readline from 'node:readline';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'cli-scaffold-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); jest.restoreAllMocks(); });

test('intended tree, built export, repeated mounts and duplicate refusal', () => {
  initAggregate('orders', root);
  addEntity('line', 'orders', root);
  addEntity('note', 'orders', root);
  const file = join(root, 'src/domains/orders/aggregate.ts');
  const content = readFileSync(file, 'utf8');
  expect(content).toContain('line: _entity_line, note: _entity_note,');
  expect(content).toContain('export const orders = ordersAggregate.build()');
  expect(existsSync(join(root, 'src/domains/orders/mixins'))).toBe(true);
  expect(() => addEntity('line', 'orders', root)).toThrow();
  expect(() => initAggregate('orders', root)).toThrow();
  expect(readFileSync(file, 'utf8')).toBe(content);
});

test.each(['../bad', 'a/b', 'a\\b', '.', '', 'class', 'constructor', 'prototype', '__proto__', 'a;ls', 'a"', 'a\n'])('invalid name %j leaves no output', name => {
  expect(() => validName(name)).toThrow();
  expect(() => initAggregate(name, root)).toThrow();
  expect(() => addEntity(name, 'orders', root)).toThrow();
  expect(existsSync(join(root, 'src'))).toBe(false);
});

test.each(['selectors', 'createAggregate', 'lineEntity', 'expect', 'reduce'])('accepted name %s uses isolated imports and retains generated mounts', name => {
  initAggregate(name, root);
  addEntity('line', name, root);
  addEntity('note', name, root);
  const content = readFileSync(join(root, `src/domains/${name}/aggregate.ts`), 'utf8');
  expect(content).toContain(`export const ${name}Aggregate = _createAggregate<_State, '${name}'>('${name}', _InitialState)`);
  expect(content).toContain(`export const ${name} = ${name}Aggregate.build()`);
  expect(content).toContain("import { lineEntity as _entity_line } from './entities/line'");
  expect(content).toContain('line: _entity_line, note: _entity_note,');
});

test('missing target, symlink paths and collisions are refused before output', () => {
  expect(() => addEntity('line', 'missing', root)).toThrow();
  symlinkSync(tmpdir(), join(root, 'src'));
  expect(() => initAggregate('orders', root)).toThrow(/Symlink/);
  rmSync(join(root, 'src'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src/domains'), 'sentinel');
  expect(() => initAggregate('orders', root)).toThrow(/directory/);
  expect(readFileSync(join(root, 'src/domains'), 'utf8')).toBe('sentinel');
});

test('shared files and custom aggregates stay byte-identical', () => {
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src/test-utils.ts'), 'helper sentinel');
  writeFileSync(join(root, 'schema-registry.json'), 'manifest sentinel');
  writeFileSync(join(root, 'package.json'), '{"scripts":{"build":"custom"}}');
  initAggregate('orders', root);
  const file = join(root, 'src/domains/orders/aggregate.ts');
  const custom = 'export const custom = 42;\n';
  writeFileSync(file, custom);
  addEntity('line', 'orders', root);
  expect(readFileSync(file, 'utf8')).toBe(custom);
  expect(readFileSync(join(root, 'src/test-utils.ts'), 'utf8')).toBe('helper sentinel');
  expect(readFileSync(join(root, 'schema-registry.json'), 'utf8')).toBe('manifest sentinel');
  expect(readFileSync(join(root, 'package.json'), 'utf8')).toBe('{"scripts":{"build":"custom"}}');
});

test('installer uses fixed argv, shell false and propagates failure', async () => {
  const child = new EventEmitter();
  const spy = jest.spyOn(childProcess, 'spawn').mockReturnValue(child as childProcess.ChildProcess);
  const installation = runInstall(['zod@^4.3.6'], false);
  expect(spy).toHaveBeenCalledWith(expect.any(String), expect.arrayContaining(['zod@^4.3.6']), { shell: false, stdio: 'inherit' });
  child.emit('exit', 1);
  await expect(installation).rejects.toThrow(/failed/);
  expect(() => runInstall(['evil; command'], false)).toThrow();
});

test('no-install preflight never spawns', async () => {
  const spy = jest.spyOn(childProcess, 'spawn');
  await preflight(true);
  expect(spy).not.toHaveBeenCalled();
});

test('preflight is advisory and preserves an existing incompatible Zod dependency', async () => {
  const original = process.cwd();
  const content = JSON.stringify({ dependencies: { '@redemeine/aggregate': '*', '@redemeine/kernel': '*', zod: '^3.0.0' }, devDependencies: { '@redemeine/cli': '*', typescript: '*', vitest: '*' } });
  writeFileSync(join(root, 'package.json'), content);
  const spawn = jest.spyOn(childProcess, 'spawn');
  const log = jest.spyOn(console, 'log').mockImplementation(() => {});
  try {
    process.chdir(root);
    await preflight(true);
  } finally { process.chdir(original); }
  expect(spawn).not.toHaveBeenCalled();
  expect(log).toHaveBeenCalledWith(expect.stringContaining('Use Zod 4'));
  expect(readFileSync(join(root, 'package.json'), 'utf8')).toBe(content);
});

test('non-TTY preflight never prompts or spawns', async () => {
  const spawn = jest.spyOn(childProcess, 'spawn');
  const prompt = jest.spyOn(readline, 'createInterface');
  expect(Boolean(process.stdin.isTTY && process.stdout.isTTY)).toBe(false);
  await preflight(false);
  expect(spawn).not.toHaveBeenCalled();
  expect(prompt).not.toHaveBeenCalled();
});

test.each(['y', 'yes', 'n', ''])('installation consent is explicit: %j', async answer => {
  const rl = Object.assign(new EventEmitter(), {
    question: jest.fn((_question: string, callback: (answer: string) => void) => callback(answer)),
    close: jest.fn(),
  });
  jest.spyOn(readline, 'createInterface').mockReturnValue(rl as unknown as readline.Interface);
  await expect(confirmInstall()).resolves.toBe(['y', 'yes'].includes(answer));
  expect(rl.close).toHaveBeenCalled();
});

test('installation EOF declines consent', async () => {
  const rl = Object.assign(new EventEmitter(), { question: jest.fn(), close: jest.fn() });
  jest.spyOn(readline, 'createInterface').mockReturnValue(rl as unknown as readline.Interface);
  const consent = confirmInstall();
  rl.emit('close');
  await expect(consent).resolves.toBe(false);
});

test('installer process errors propagate', async () => {
  const child = new EventEmitter();
  jest.spyOn(childProcess, 'spawn').mockReturnValue(child as childProcess.ChildProcess);
  const installation = runInstall(['vitest'], true);
  child.emit('error', new Error('spawn failed'));
  await expect(installation).rejects.toThrow('spawn failed');
});
