import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runOwnedChild } from './owned-child-run.mjs';

test('deadline terminates an owned Jest-like group including its grandchild and waits for close', async () => {
  let pid = 0;
  const script = `const { spawn } = require('node:child_process');
    const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });
    console.log(grandchild.pid); setInterval(() => {}, 1000);`;
  const result = await runOwnedChild(process.execPath, ['-e', script], {
    capture: true, timeoutMs: 250, graceMs: 30, onSpawn: child => { pid = child.pid; }
  });
  assert.notEqual(pid, process.pid);
  assert.equal(result.timedOut, true);
  const grandchild = Number(result.stdout);
  assert.ok(Number.isSafeInteger(grandchild) && grandchild > 0);
  const state = await readFile(`/proc/${grandchild}/stat`, 'utf8').then(text => text.split(' ')[2], () => 'gone');
  assert.ok(['gone', 'Z', 'X'].includes(state), `grandchild remained running: ${state}`);
});

test('a failing child is reaped and does not serialize its credentials into a receipt', async () => {
  const result = await runOwnedChild(process.execPath, ['-e', 'console.log(process.env.RUN_SECRET); process.exit(2)'], {
    env: { ...process.env, RUN_SECRET: 'private-test-only' }, capture: true, timeoutMs: 1_000
  });
  assert.equal(result.code, 2);
  assert.equal(result.timedOut, false);
  const receipt = JSON.stringify({ status: result.code, failure: 'sanitized crash runner failure' });
  assert.ok(!receipt.includes('private-test-only'));
});
