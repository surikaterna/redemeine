import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import * as ts from 'typescript';

test('scoped callable properties do not override shorthand while packed objects retain their prefix', () => {
  const source = readFileSync(join(__dirname, 'callableCommands.fixture.ts.txt'), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } });
  const consumer = { exerciseCallableCommands: () => ({ received: [], packed: [] }) };
  new Function('require', 'exports', compiled.outputText)(require, consumer);
  expect(consumer.exerciseCallableCommands()).toEqual({
    received: [{ rowId: 'one', rowsId: 'one', id: 'one' }],
    packed: [{ rowId: 'one', count: 3 }]
  });
});

test('public ESM exports preserve scoped callable and packed payloads', () => {
  const source = readFileSync(join(__dirname, 'callableCommands.fixture.ts.txt'), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } });
  const output = execFileSync(process.execPath, ['--input-type=module', '-e',
    `${compiled.outputText}\nconsole.log(JSON.stringify(exerciseCallableCommands()));`
  ], { cwd: join(__dirname, '..'), encoding: 'utf8' });
  expect(JSON.parse(output)).toEqual({
    received: [{ rowId: 'one', rowsId: 'one', id: 'one' }],
    packed: [{ rowId: 'one', count: 3 }]
  });
});
