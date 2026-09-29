import assert from 'node:assert/strict';
import { test } from 'node:test';
import { waitForRabbitApp } from './topology-app-ready.cjs';

test('shared readiness waits for check_running after ping success within per-probe and overall budgets', async () => {
  const calls = [];
  let checks = 0;
  await waitForRabbitApp({ probe: async (command, timeoutMs) => {
    assert.ok(timeoutMs > 0 && timeoutMs <= 5);
    calls.push(command);
    if (command === 'ping') return { code: 0, status: 'exit' };
    return { code: ++checks === 3 ? 0 : 64, status: 'exit' };
  }, isExited: async () => false, deadlineMs: 200, probeMs: 5, delayMs: 1 });
  assert.deepEqual(calls, ['ping', 'check_running', 'ping', 'check_running', 'ping', 'check_running']);
});

test('app not running before shared deadline and exited container both fail closed', async () => {
  await assert.rejects(waitForRabbitApp({ probe: async () => ({ code: 64, status: 'exit' }),
    isExited: async () => false, deadlineMs: 15, delayMs: 2 }), /deadline exceeded/);
  await assert.rejects(waitForRabbitApp({ probe: async () => ({ code: 1, status: 'exit' }),
    isExited: async () => true, deadlineMs: 100 }), /exited/);
});
