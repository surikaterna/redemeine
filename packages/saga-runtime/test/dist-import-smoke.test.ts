import { expect, test } from '@jest/globals';
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

test('built saga package is ESM importable', async () => {
  const sagaDistPath = resolve(__dirname, '../../saga/dist/index.js');
  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '--eval', `import(${JSON.stringify(sagaDistPath)}).then((m)=>console.log(typeof m.runSagaHandler))`]);
  expect(stdout.trim()).toBe('function');
});

test('built saga-runtime package is ESM importable', async () => {
  const sagaRuntimeDistPath = resolve(__dirname, '../dist/index.js');
  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '--eval', `import(${JSON.stringify(sagaRuntimeDistPath)}).then((m)=>console.log([typeof m.createSagaAggregate, typeof m.createSagaDispatchContext, typeof m.runSagaHandler].join(',')))`]);
  expect(stdout.trim()).toBe('function,function,function');
});
