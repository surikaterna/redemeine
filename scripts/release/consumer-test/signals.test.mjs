import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { cleanup, docker, dockerRun } from '../consumer-docker.mjs';
import { cli, manifest, put, repo, workspace } from '../test/fixtures.mjs';
import { hash } from '../workspace.mjs';

async function waitForRegistry(output) {
  for (let attempt = 0; attempt < 600; attempt++) {
    let id;
    try {
      id = JSON.parse(await readFile(resolve(output, 'run.json'), 'utf8')).runId;
    } catch {
      await new Promise((accept) => setTimeout(accept, 100));
      continue;
    }
    const containers = await docker(['ps', '-q', '--filter', `label=org.redemeine.consumer-run=${id}`]);
    if (containers) return id;
    await new Promise((accept) => setTimeout(accept, 100));
  }
  throw new Error('Signal control did not reach registry deadline');
}

test('SIGTERM retains incomplete receipt and cleans only labeled run resources', { timeout: 180000 }, async (t) => {
  const policyBytes = await readFile(resolve(repo, 'scripts/release/policy.json'));
  const fixture = await workspace([manifest('@fixture/signal')], JSON.parse(policyBytes));
  await put(resolve(fixture.root, 'scripts/release/policy.json'), policyBytes);
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  assert.equal((await cli(fixture)).status, 0);
  const directory = await mkdtemp(resolve(tmpdir(), 'consumer-signal-'));
  const path = resolve(fixture.output, 'manifest.json');
  const output = resolve(directory, 'b');
  const child = spawn(
    process.execPath,
    [resolve(repo, 'scripts/release/consumer.mjs'), '--manifest', path, '--manifest-sha256', hash(await readFile(path)), '--output', output],
    { stdio: 'ignore' }
  );
  const exit = new Promise((accept) => child.once('exit', (code, signal) => accept({ code, signal })));
  t.after(() => {
    if (child.exitCode === null) child.kill('SIGKILL');
  });
  const id = await waitForRegistry(output);
  t.after(async () => {
    const state = dockerRun(output, {});
    state.id = id;
    await cleanup(state);
  });
  child.kill('SIGTERM');
  assert.deepEqual(await exit, { code: 2, signal: null });
  const report = JSON.parse(await readFile(resolve(output, 'result.json'), 'utf8'));
  assert.equal(report.interrupted, 'SIGTERM');
  assert.equal(report.complete, false);
  assert.equal(report.cleanup.complete, true);
  assert.equal(await docker(['ps', '-aq', '--filter', `label=org.redemeine.consumer-run=${id}`]), '');
  assert.equal(await docker(['network', 'ls', '-q', '--filter', `label=org.redemeine.consumer-run=${id}`]), '');
  console.log(`Signal evidence: ${output}`);
});
