import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { audit } from '../check.mjs';
import { qualify } from '../consumer.mjs';
import { put, repo, workspace } from '../test/fixtures.mjs';
import { hash } from '../workspace.mjs';
import { isExpectedCliCoverage } from './real-control-verdict.mjs';

async function attempt(root, parent, roots = []) {
  const output = resolve(parent, 'a');
  const a = await audit(root, { output });
  const manifest = resolve(output, 'manifest.json');
  const b = await qualify({
    manifest,
    'manifest-sha256': hash(await readFile(manifest)),
    output: resolve(parent, 'b'),
    root: roots,
    'external-proxy': 'npmjs'
  });
  console.log(JSON.stringify({ evidence: parent, a, b: b.exitCode, stages: b.staging.receipts.length, consumers: b.consumers.length }));
  return { a, b };
}

const parent = await mkdtemp(resolve(tmpdir(), 'consumer-real-repository-'));
const full = await attempt(repo, parent);
assert.equal(full.a, 1, 'Current repository expected deterministic artifact violations, not incomplete infrastructure');
assert.equal(full.b.exitCode, 1);
assert.equal(full.b.staging.receipts.length, 0);
assert.equal(full.b.images, undefined);

const policyBytes = await readFile(resolve(repo, 'scripts/release/policy.json'));
const cliBytes = await readFile(resolve(repo, 'packages/cli/package.json'));
const fixture = await workspace([JSON.parse(cliBytes)], JSON.parse(policyBytes));
await put(resolve(fixture.root, 'scripts/release/policy.json'), policyBytes);
const dir = resolve(fixture.root, 'nested/group/p0');
await put(resolve(dir, 'package.json'), cliBytes);
await rm(resolve(dir, 'dist'), { recursive: true, force: true });
await cp(resolve(repo, 'packages/cli/dist'), resolve(dir, 'dist'), { recursive: true });
await cp(resolve(repo, 'packages/cli/README.md'), resolve(dir, 'README.md'));
await writeFile(
  resolve(fixture.root, 'control-source.json'),
  JSON.stringify({
    source: 'unchanged packages/cli manifest and previously built dist copied BEFORE Slice A',
    packageJsonSha256: hash(cliBytes),
    fixtureOnly: true,
    sourceRepository: repo
  })
);
const cliParent = await mkdtemp(resolve(tmpdir(), 'consumer-real-cli-'));
const cliResult = await attempt(fixture.root, cliParent, ['@redemeine/cli@0.1.0']);
const blocked = isExpectedCliCoverage(cliResult.b);
if (!blocked) process.exitCode = 2;
console.log(
  'Real CLI coverage retained without repair/override; missing generated-project prerequisite is incomplete2, not an artifact defect. This is NOT full release qualification.'
);
