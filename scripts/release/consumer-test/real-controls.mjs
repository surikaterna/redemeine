import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { audit } from '../check.mjs';
import { qualify } from '../consumer.mjs';
import { tools } from '../consumer-docker.mjs';
import { selectRoots } from '../consumer-graph.mjs';
import { loadInput } from '../consumer-input.mjs';
import { put, repo, workspace } from '../test/fixtures.mjs';
import { hash } from '../workspace.mjs';
import { isExpectedCliCoverage, isExpectedRepositoryRejection } from './real-control-verdict.mjs';

async function attempt(root, parent, roots = []) {
  const output = resolve(parent, 'a');
  const a = await audit(root, { output });
  const manifest = resolve(output, 'manifest.json');
  const digest = hash(await readFile(manifest));
  const policy = await readFile(resolve(repo, 'scripts/release/policy.json'));
  const input = await loadInput(manifest, digest, resolve(parent, 'control-input'), policy);
  const context = { a, input, roots, pins: tools, selection: input.verdict === 0 ? selectRoots(input, roots) : undefined };
  const b = await qualify({
    manifest,
    'manifest-sha256': digest,
    output: resolve(parent, 'b'),
    root: roots,
    'external-proxy': 'npmjs'
  });
  console.log(JSON.stringify({ evidence: parent, a, b: b.exitCode, stages: b.staging?.receipts?.length, consumers: b.consumers?.length }));
  return { a, b, context };
}

const parent = await mkdtemp(resolve(tmpdir(), 'consumer-real-repository-'));
const full = await attempt(repo, parent);
assert(isExpectedRepositoryRejection(full.b, full.context), 'Expected same-input A violations before any staging/resources/consumers');

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
const blocked = isExpectedCliCoverage(cliResult.b, cliResult.context);
if (!blocked) process.exitCode = 2;
console.log(
  'Real CLI coverage retained without repair/override; missing generated-project prerequisite is incomplete2, not an artifact defect. This is NOT full release qualification.'
);
