import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { removeOwned, runPrecode } from './run-precode-intent-discovery.mjs';

const digest = (path) => createHash('sha256').update(readFileSync(new URL(path, import.meta.url))).digest('hex');
const expected = () => ({ head: 'b'.repeat(40), testSha256: digest('./precode-intent-discovery.integration.test.ts'),
  runnerSha256: digest('./run-precode-intent-discovery.mjs') });

test('cleanup checks absence of only the owned ID', async () => {
  const calls = [];
  const result = await removeOwned(async (_program, args) => {
    calls.push(args);
    return { code: 0, output: '' };
  }, 'owned-id');
  assert.equal(result.absent, true);
  assert.deepEqual(calls[0], ['rm', '-f', 'owned-id']);
  assert.deepEqual(calls[1], ['ps', '-a', '--no-trunc', '--filter', 'id=owned-id', '--format', '{{.ID}}']);
  await assert.rejects(removeOwned(async (_program, args) => ({ code: 0, output: args[0] === 'ps' ? 'owned-id' : '' }),
    'owned-id'), /unverified/);
});

test('runner removes its container and writes receipt after Jest failure, without Docker', async () => {
  const calls = [];
  const written = [];
  const run = async (program, args) => {
    calls.push([program, ...args]);
    if (program === 'git') return { code: 0, output: args[0] === 'status' ? '' : expected().head };
    if (program === 'pnpm') return { code: 1, output: '' };
    if (args[0] === 'image') return { code: 0, output: `mongo@sha256:${'a'.repeat(64)}` };
    if (args[0] === 'run') return { code: 0, output: 'owned-id' };
    if (args[0] === 'exec') return { code: 0, output: args.some((arg) => arg.includes('buildInfo:1')) ? '8.0.14' : '1' };
    return { code: 0, output: '' };
  };
  const receipt = await runPrecode({ run, expected: expected(), port: async () => 27049,
    write: (path, text, options) => written.push({ path, data: JSON.parse(text), options }) });
  assert.equal(receipt.exit, 1);
  assert.equal(receipt.status, 'FAILED');
  assert.equal(receipt.cleanup.absent, true);
  assert.equal(receipt.head, expected().head);
  assert.equal(receipt.mongoVersion, '8.0.14');
  assert.ok(receipt.testSha256.length === 64);
  assert.equal(written[0].options.flag, 'wx');
  assert.equal(written[0].data.cleanup.absent, true);
  assert.deepEqual(calls.slice(0, 2).map((entry) => entry[1]), ['status', 'rev-parse']);
  assert.ok(calls.some((entry) => entry[1] === 'run'));
  assert.ok(calls.findIndex((entry) => entry[0] === 'pnpm') < calls.findIndex((entry) => entry[1] === 'rm'));
});

test('setup failure removes only started container and never invokes Jest', async () => {
  const calls = [];
  const run = async (program, args) => {
    calls.push([program, ...args]);
    if (program === 'git') return { code: 0, output: args[0] === 'status' ? '' : expected().head };
    if (args[0] === 'image') return { code: 0, output: `mongo@sha256:${'a'.repeat(64)}` };
    if (args[0] === 'run') return { code: 0, output: 'owned-id' };
    if (args[0] === 'exec' && args.some((arg) => arg.includes('rs.initiate'))) {
      return { code: 1, output: '', error: 'init failure' };
    }
    return { code: 0, output: args[0] === 'exec' ? '1' : '' };
  };
  const receipt = await runPrecode({ run, expected: expected(), port: async () => 27049, write: () => {} });
  assert.equal(receipt.status, 'FAILED');
  assert.equal(receipt.cleanup.absent, true);
  assert.equal(calls.some(([program]) => program === 'pnpm'), false);
  assert.equal(calls.filter(([, action]) => action === 'rm').length, 1);
});

test('missing approval, dirty/untracked worktree and mismatched HEAD or script hashes refuse before Docker or receipt', async () => {
  for (const scenario of ['missing', 'dirty', 'head', 'testHash', 'runnerHash']) {
    const calls = [];
    let receipts = 0;
    const identity = expected();
    if (scenario === 'head') identity.head = 'c'.repeat(40);
    if (scenario === 'testHash') identity.testSha256 = 'c'.repeat(64);
    if (scenario === 'runnerHash') identity.runnerSha256 = 'c'.repeat(64);
    const run = async (program, args) => {
      calls.push([program, ...args]);
      if (program !== 'git') throw new Error('Docker/Jest reached before preflight');
      return { code: 0, output: args[0] === 'status' ? (scenario === 'dirty' ? '?? integration/untracked.test.ts' : '')
        : expected().head };
    };
    await assert.rejects(runPrecode({ run, expected: scenario === 'missing' ? {} : identity,
      port: async () => { throw new Error('port allocated before preflight'); }, write: () => { receipts++; } }),
    /Require full|Dirty worktree|HEAD mismatch|Script hash mismatch/);
    assert.equal(calls.every(([program]) => program === 'git'), true);
    assert.equal(receipts, 0);
  }
});
