import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { audit } from '../check.mjs';
import { qualify } from '../consumer.mjs';
import { manifest, put, repo, workspace } from '../test/fixtures.mjs';
import { hash } from '../workspace.mjs';

const policyBytes = await readFile(resolve(repo, 'scripts/release/policy.json'));
const fixture = await workspace([manifest('isolated-real-kernel-control', { dependencies: { '@redemeine/kernel': '0.2.0-pre.0' } })], JSON.parse(policyBytes));
await put(resolve(fixture.root, 'scripts/release/policy.json'), policyBytes);
const exit = await audit(fixture.root, { output: fixture.output });
console.log(`Isolated real-kernel A evidence: ${fixture.output}`);
assert.equal(exit, 0, 'Original kernel control A must be complete green; no bypass');
const parent = await mkdtemp(resolve(tmpdir(), 'consumer-real-kernel-'));
const path = resolve(fixture.output, 'manifest.json');
const report = await qualify({
  manifest: path,
  'manifest-sha256': hash(await readFile(path)),
  output: resolve(parent, 'result'),
  root: ['@redemeine/kernel@0.2.0-pre.0'],
  'external-proxy': 'npmjs'
});
console.log(`Original kernel (NOT current repo release) B evidence: ${parent}/result`);
assert.equal(report.exitCode, 0, JSON.stringify(report, null, 2));
assert.equal(report.staging.receipts[0].integrity, 'sha512-PaczICHWoLYMRjsAQdeGK7cZbchn3EZzxFVP3wn+yVfXURUB7SIRWkP/mqJ/3NVWKXbYV6ZRBPBrRu2wDPGqVQ==');
