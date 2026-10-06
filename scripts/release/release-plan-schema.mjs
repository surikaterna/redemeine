import { isDeepStrictEqual as equal } from 'node:util';
import semver from 'semver';
import { z } from 'zod';
import { hash } from './workspace.mjs';

const text = z.string().min(1).max(4096);
const name = z
  .string()
  .regex(/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/)
  .max(214);
const version = z.string().refine((value) => semver.valid(value) === value);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const jsonObject = z.record(text, z.json());
const edge = z.object({ from: name, field: z.enum(['dependencies', 'optionalDependencies', 'peerDependencies']), name, version }).strict();
export const intentSchema = z
  .object({
    schemaVersion: z.literal(1),
    actor: text,
    channel: z.enum(['pre', 'stable']),
    destinationTag: z.enum(['pre', 'latest']),
    selected: z.array(z.object({ name, version }).strict()).min(1).max(1000),
    candidateEdges: z.array(edge).max(10000),
    exclusions: z.record(name, z.object({ reason: text, held: z.boolean() }).strict()),
    changesets: z.record(text, text)
  })
  .strict();

export const planSchema = z
  .object({
    schemaVersion: z.literal(1),
    purpose: z.literal('nonpublishing release plan'),
    livePublishing: z.literal(false),
    timestamp: z.iso.datetime(),
    classification: z.enum(['repository', 'fixture-rehearsal']),
    intent: intentSchema,
    intentSha256: digest,
    repository: z
      .object({
        sha: z.string().regex(/^[a-f0-9]{40}$/),
        dirty: z.boolean(),
        diffSha256: digest,
        untracked: z.array(z.object({ path: text, type: z.enum(['file', 'symlink']), sha256: digest }).strict()).max(10000),
        snapshotIdentity: digest
      })
      .strict(),
    tools: z.object({ node: text, pnpm: text, npm: text, packageManager: text, helpers: z.record(text, text) }).strict(),
    inputs: z.record(
      z
        .string()
        .regex(
          /^(?:package\.json|pnpm-(?:lock|workspace)\.yaml|scripts\/release\/(?:policy|consumer-tools)\.json|\.changeset\/(?:config\.json|pre\.json|[a-zA-Z0-9-]+\.md))$/
        ),
      digest
    ),
    policy: jsonObject,
    pre: jsonObject.nullable(),
    workspaces: z
      .array(
        z
          .object({
            name,
            version,
            sourcePath: text,
            selection: z.enum(['private', 'held-audit', 'candidate', 'not-selected']),
            manifest: jsonObject,
            manifestSha256: digest
          })
          .strict()
      )
      .min(1)
      .max(1000),
    changesets: z
      .array(
        z
          .object({
            id: text,
            sha256: digest,
            consumed: z.boolean(),
            disposition: text,
            releases: z.array(z.object({ name, type: z.enum(['major', 'minor', 'patch']) }).strict()).max(1000)
          })
          .strict()
      )
      .max(1000),
    changesetsStatusSha256: digest,
    registry: z
      .array(
        z
          .object({
            name,
            timestamp: z.iso.datetime(),
            missing: z.boolean(),
            sha256: digest.nullable(),
            versions: z.array(version).max(10000),
            tags: z.record(text, version),
            origin: z.enum(['fixture', 'https://registry.npmjs.org/'])
          })
          .strict()
      )
      .max(1000),
    uploadTag: z.string().regex(/^rehearsal-[a-f0-9]{24}$/),
    status: z.enum(['proposed-unapplied', 'applied']),
    blockers: z.array(text).max(10000)
  })
  .strict();

export function requirePlan(condition, message) {
  if (!condition) throw new Error(message);
}

export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonical(value[key])])
  );
}

export const canonicalBytes = (value) => Buffer.from(`${JSON.stringify(canonical(value))}\n`);

export function selectionFor(workspace, intent, policy) {
  if (workspace.manifest.private === true) return 'private';
  if (Object.hasOwn(policy.holds, workspace.name) || intent.exclusions[workspace.name]?.held) return 'held-audit';
  return intent.selected.some((item) => item.name === workspace.name) ? 'candidate' : 'not-selected';
}

export function validateIntent(intent, workspaces, policy, pre) {
  intentSchema.parse(intent);
  const selected = intent.selected.map((item) => item.name);
  requirePlan(new Set(selected).size === selected.length, 'Duplicate selected name');
  requirePlan(
    intent.channel === 'pre'
      ? intent.destinationTag === 'pre' && pre?.mode === 'pre' && pre.tag === 'pre'
      : intent.destinationTag === 'latest' && pre?.mode !== 'pre',
    'Explicit channel disagrees with source pre state'
  );
  for (const item of intent.selected) validateCandidate(item, intent, workspaces, policy);
  const expected = workspaces
    .filter((item) => !selected.includes(item.name))
    .map((item) => item.name)
    .sort();
  requirePlan(equal(Object.keys(intent.exclusions).sort(), expected), 'Every unselected workspace needs an explicit exclusion');
  const edges = intent.candidateEdges.map((item) => `${item.from}:${item.field}:${item.name}`);
  requirePlan(new Set(edges).size === edges.length, 'Duplicate candidate edge');
  for (const item of intent.candidateEdges) {
    requirePlan(
      selected.includes(item.from) && intent.selected.some((target) => target.name === item.name && target.version === item.version),
      'Candidate edge must join exact reviewed selected identities'
    );
  }
}

function validateCandidate(item, intent, workspaces, policy) {
  const workspace = workspaces.find((entry) => entry.name === item.name);
  requirePlan(workspace && !workspace.manifest.private && !Object.hasOwn(policy.holds, item.name), 'Missing/private/held selection');
  requirePlan(!['@redemeine/testing', '@redemeine/cli'].includes(item.name), 'Testing and CLI remain held for this phase');
  requirePlan(!(policy.knownBad[item.name] || []).includes(item.version), 'Known-bad candidate version');
  const pre = semver.prerelease(item.version);
  requirePlan(intent.channel === 'pre' ? pre?.[0] === 'pre' : pre === null, 'Candidate version disagrees with explicit channel');
}

export function appliedBlockers(intent, workspaces, registry) {
  const blockers = [];
  for (const item of intent.selected) {
    const workspace = workspaces.find((entry) => entry.name === item.name);
    if (workspace.version !== item.version) blockers.push(`Unapplied version: ${item.name}@${item.version}; source ${workspace.version}`);
    if (registry.find((entry) => entry.name === item.name)?.versions.includes(item.version))
      blockers.push(`Version already exists: ${item.name}@${item.version}`);
  }
  for (const item of intent.candidateEdges) {
    const workspace = workspaces.find((entry) => entry.name === item.from);
    if (workspace.manifest[item.field]?.[item.name] !== item.version)
      blockers.push(`Unapplied exact edge: ${item.from} ${item.field} ${item.name}@${item.version}`);
  }
  return blockers;
}

export function validatePlan(plan) {
  planSchema.parse(plan);
  validatePlanSources(plan);
  validateIntent(plan.intent, plan.workspaces, plan.policy, plan.pre);
  requirePlan(plan.intentSha256 === hash(canonicalBytes(plan.intent)), 'Intent digest mismatch');
  requirePlan(plan.uploadTag === `rehearsal-${plan.intentSha256.slice(0, 24)}`, 'Upload tag is not plan-bound');
  requirePlan(plan.tools.helpers['@changesets/cli'] === '2.31.0', 'Unsupported Changesets version');
  requirePlan(
    equal(
      plan.registry.map((item) => item.name).sort(),
      plan.workspaces
        .filter((item) => !item.manifest.private)
        .map((item) => item.name)
        .sort()
    ),
    'Plan registry inventory mismatch'
  );
  for (const item of plan.registry) {
    requirePlan(Date.parse(item.timestamp) <= Date.parse(plan.timestamp), 'Plan registry observation is from the future');
    requirePlan(new Set(item.versions).size === item.versions.length && item.missing === (item.sha256 === null), 'Plan registry snapshot contradiction');
    requirePlan(!item.missing || item.versions.length === 0, 'Missing registry has versions');
  }
  if (plan.classification === 'fixture-rehearsal') {
    requirePlan(
      plan.intent.selected.every((item) => item.name.startsWith('@fixture/')),
      'Fixture classification cannot authorize repository packages'
    );
  }
  requirePlan(new Set(plan.workspaces.map((item) => item.name)).size === plan.workspaces.length, 'Duplicate plan workspace');
  requirePlan(new Set(plan.workspaces.map((item) => item.sourcePath)).size === plan.workspaces.length, 'Duplicate plan source path');
  for (const item of plan.workspaces) {
    requirePlan(item.manifest.name === item.name && item.manifest.version === item.version, 'Plan manifest identity mismatch');
    requirePlan(item.selection === selectionFor(item, plan.intent, plan.policy), 'Plan membership mismatch');
  }
  const blockers = appliedBlockers(plan.intent, plan.workspaces, plan.registry);
  requirePlan(equal(plan.blockers, blockers) && plan.status === (blockers.length ? 'proposed-unapplied' : 'applied'), 'Contradictory applied status');
  return plan;
}

function validatePlanSources(plan) {
  const files = [
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'scripts/release/policy.json',
    'scripts/release/consumer-tools.json',
    '.changeset/config.json'
  ];
  if (plan.pre) files.push('.changeset/pre.json');
  requirePlan(equal(Object.keys(plan.intent.changesets).sort(), plan.changesets.map((item) => item.id).sort()), 'Plan changeset inventory mismatch');
  for (const item of plan.changesets) {
    const path = `.changeset/${item.id}.md`;
    files.push(path);
    requirePlan(plan.inputs[path] === item.sha256 && item.disposition === plan.intent.changesets[item.id], 'Plan changeset hash/disposition mismatch');
    requirePlan(item.consumed === Boolean(plan.pre?.changesets?.includes(item.id)), 'Pre-consumed intent mismatch');
  }
  requirePlan(equal(Object.keys(plan.inputs).sort(), files.sort()), 'Plan source inputs missing/extra');
  for (const item of plan.registry) {
    requirePlan(item.origin === (plan.classification === 'repository' ? 'https://registry.npmjs.org/' : 'fixture'), 'Plan registry source mismatch');
  }
}

export function plannedCandidateEdge(plan, edge) {
  return (
    edge.origin === 'candidate' &&
    plan?.intent.candidateEdges.some(
      (item) =>
        item.from === edge.package &&
        item.field === edge.field &&
        item.name === edge.name &&
        item.name === edge.canonical &&
        item.version === edge.spec &&
        item.version === edge.sourceSpec
    )
  );
}
