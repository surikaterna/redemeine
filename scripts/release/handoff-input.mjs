import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { isDeepStrictEqual as equal } from 'node:util';
import { z } from 'zod';
import { boundedRead, containedRead } from './consumer-files.mjs';
import { artifactKey } from './consumer-graph.mjs';
import { loadInput } from './consumer-input.mjs';
import { parseJson } from './consumer-json.mjs';
import { demand, digest, inputVerdict, manifestSchema } from './consumer-schema.mjs';
import { validateConsumerEvidence } from './handoff-evidence.mjs';
import { loadPlan } from './release-plan.mjs';
import { canonicalBytes } from './release-plan-schema.mjs';
import { hash } from './workspace.mjs';

const fileSchema = z
  .object({
    path: z.string().min(1).max(4096),
    sha256: digest,
    size: z
      .number()
      .int()
      .nonnegative()
      .max(32 * 1024 * 1024)
  })
  .strict();
export const envelopeSchema = z
  .object({
    schemaVersion: z.literal(1),
    livePublishing: z.literal(false),
    purpose: z.literal('local-only exact-byte rehearsal'),
    classification: z.enum(['repository', 'fixture-rehearsal']),
    planSha256: digest,
    aSha256: digest,
    bSha256: digest,
    globalSha256: digest,
    sourceSnapshot: digest,
    toolsSnapshot: digest,
    sourceSha: z.string().regex(/^[a-f0-9]{40}$/),
    uploadTag: z.string(),
    destinationTag: z.enum(['pre', 'latest']),
    order: z.array(z.string()).min(1).max(1000),
    artifacts: z
      .array(
        z
          .object({
            key: z.string(),
            origins: z.array(z.string()),
            archive: z.string(),
            size: z.number().int().positive(),
            sha256: digest,
            integrity: z.string(),
            manifestSha256: digest,
            candidate: z.boolean()
          })
          .strict()
      )
      .min(1)
      .max(1000),
    files: z.array(fileSchema).min(1).max(10000)
  })
  .strict();

export async function trustedPolicy(plan) {
  if (plan.classification === 'repository') return readFile(new URL('./policy.json', import.meta.url));
  demand(
    plan.workspaces.every((item) => item.name.startsWith('@fixture/') || ['fixture-root', 'fixture-website'].includes(item.name)),
    'Unsupported fixture ownership'
  );
  const expected = {
    schemaVersion: 1,
    registry: 'https://registry.npmjs.org/',
    internalScopes: ['@fixture'],
    holds: { '@fixture/held': { owner: 'test', reason: 'Private dependency; excluded before A' } },
    knownBad: {}
  };
  demand(equal(plan.policy, expected), 'Unsupported fixture policy');
  return Buffer.from(JSON.stringify(expected));
}

export async function copyBound(root, path, expected, destination, files) {
  digest.parse(expected);
  demand(!files.some((file) => file.path === path), 'Duplicate bundle path');
  const bytes = await containedRead(root, path, 32 * 1024 * 1024);
  demand(hash(bytes) === expected, `Evidence digest mismatch: ${path}`);
  demand(files.reduce((sum, item) => sum + item.size, bytes.length) <= 256 * 1024 * 1024, 'Bundle exceeds byte bound');
  const target = resolve(destination, path);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
  files.push({ path, sha256: expected, size: bytes.length });
  return bytes;
}

export async function admitBundle(root, expected, snapshot) {
  const loaded = await loadPlan(resolve(root, 'plan/plan.json'), expected.planSha256);
  const { plan } = loaded;
  demand(plan.status === 'applied', 'Cannot hand off unapplied intent');
  await validatePlanEvidence(root, plan);
  demand(plan.classification !== 'repository' || plan.repository.dirty === false, 'Repository handoff requires clean source');
  const input = await loadInput(resolve(root, 'a/manifest.json'), expected.aSha256, snapshot, await trustedPolicy(plan));
  demand(input.verdict === 0 && input.manifest.schemaVersion === 2, 'Handoff requires genuine whole-green selected A v2');
  demand(input.manifest.releasePlan.sha256 === loaded.sha256 && equal(input.manifest.releasePlan.plan, plan), 'Handoff A plan mismatch');
  demand(Date.parse(input.manifest.timestamp) >= Date.parse(plan.timestamp), 'A predates selected plan');
  const globalBytes = await containedRead(root, 'global/manifest.json', 16 * 1024 * 1024);
  demand(hash(globalBytes) === expected.globalSha256, 'Global digest mismatch');
  const global = manifestSchema.parse(parseJson(globalBytes));
  demand(global.schemaVersion === 1 && inputVerdict(global) !== 2 && global.complete, 'Global diagnostic audit incomplete');
  await validateGlobalFiles(root, global);
  demand(
    equal(global.repository, plan.repository) && equal(global.policy, plan.policy) && equal(global.inputs, input.manifest.inputs),
    'Global source/policy mismatch'
  );
  demand(
    equal(global.workspaces.map((w) => [w.name, w.version, w.sourcePath]).sort(), plan.workspaces.map((w) => [w.name, w.version, w.sourcePath]).sort()),
    'Global inventory mismatch'
  );
  const bBytes = await containedRead(root, 'b/result.json', 16 * 1024 * 1024);
  demand(hash(bBytes) === expected.bSha256, 'Consumer result digest mismatch');
  const report = parseJson(bBytes);
  const read = async (path, sha256) => {
    digest.parse(sha256);
    const bytes = await containedRead(root, `b/${path}`, 32 * 1024 * 1024);
    demand(hash(bytes) === sha256, `B evidence digest mismatch: ${path}`);
    return bytes;
  };
  const selection = await validateConsumerEvidence(report, input, read);
  return { plan, input, report, selection };
}

async function validateGlobalFiles(root, global) {
  const expected = global.artifacts.map((item) => ({ path: item.archive, sha256: item.sha256 }));
  expected.push(
    ...global.registrySnapshots
      .filter((item) => item.sha256)
      .map((item) => ({
        path: `registry/${encodeURIComponent(item.name)}.json`,
        sha256: item.sha256
      }))
  );
  for (const item of expected) {
    const bytes = await containedRead(root, `global/${item.path}`, 32 * 1024 * 1024);
    demand(hash(bytes) === item.sha256, 'Global diagnostic evidence missing/changed');
  }
}

async function validatePlanEvidence(root, plan) {
  const bytes = await containedRead(root, 'plan/changesets-status.json', 16 * 1024 * 1024);
  demand(hash(bytes) === plan.changesetsStatusSha256, 'Changesets status evidence mismatch');
  const status = parseJson(bytes);
  demand(
    equal(
      status.changesets.map((item) => item.id).sort(),
      plan.changesets
        .filter((item) => !item.consumed)
        .map((item) => item.id)
        .sort()
    ),
    'Changesets disposition inventory mismatch'
  );
  for (const item of status.changesets) {
    demand(equal(item.releases, plan.changesets.find((entry) => entry.id === item.id)?.releases), 'Changesets bump intent mismatch');
  }
  for (const item of plan.registry) {
    if (!item.sha256) continue;
    const bytes = await containedRead(root, `plan/registry/${encodeURIComponent(item.name)}.json`, 16 * 1024 * 1024);
    demand(hash(bytes) === item.sha256, 'Plan registry bytes mismatch');
    const data = parseJson(bytes);
    demand(
      data.name === item.name && equal(Object.keys(data.versions), item.versions) && equal(data['dist-tags'] || {}, item.tags),
      'Plan registry metadata mismatch'
    );
  }
}

export function expectedArtifacts(input, selection) {
  return selection.order.map((key) => {
    const item = input.artifacts.find((artifact) => artifactKey(artifact) === key);
    return {
      key,
      origins: item.origins,
      archive: `a/${item.archive}`,
      size: item.size,
      sha256: item.sha256,
      integrity: item.integrity,
      manifestSha256: item.manifestSha256,
      candidate: item.origins.includes('candidate')
    };
  });
}

export async function loadEnvelope(path, expected, output, toolsSnapshot) {
  digest.parse(expected);
  const bytes = await boundedRead(path, 16 * 1024 * 1024);
  demand(hash(bytes) === expected, 'Envelope digest mismatch');
  const envelope = envelopeSchema.parse(parseJson(bytes));
  demand(bytes.equals(canonicalBytes(envelope)), 'Noncanonical envelope');
  demand(envelope.toolsSnapshot === toolsSnapshot, 'Trusted tool checkout snapshot differs from producer');
  await mkdir(output, { mode: 0o700 });
  const files = [];
  for (const file of envelope.files) {
    const copied = await copyBound(dirname(path), file.path, file.sha256, output, files);
    demand(copied.length === file.size, 'Envelope file size mismatch');
  }
  const admitted = await admitBundle(output, envelope, resolve(output, 'validated-snapshot'));
  const { plan, input, selection } = admitted;
  demand(equal(envelope.artifacts, expectedArtifacts(input, selection)) && equal(envelope.order, selection.order), 'Envelope artifact/order mismatch');
  demand(
    envelope.classification === plan.classification &&
      envelope.sourceSnapshot === plan.repository.snapshotIdentity &&
      envelope.sourceSha === plan.repository.sha,
    'Envelope source mismatch'
  );
  demand(envelope.uploadTag === plan.uploadTag && envelope.destinationTag === plan.intent.destinationTag, 'Envelope channel/tag mismatch');
  return { ...admitted, envelope, sha256: expected, root: output };
}
