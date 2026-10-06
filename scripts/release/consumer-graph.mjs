import { isDeepStrictEqual } from 'node:util';
import semver from 'semver';
import { demand } from './consumer-schema.mjs';
import { plannedCandidateEdge } from './release-plan-schema.mjs';
import { edges } from './specs.mjs';

export const artifactKey = (artifact) => `${artifact.manifest.name}@${artifact.manifest.version}`;

export function ownership(manifest) {
  const names = new Set(manifest.workspaces.map((entry) => entry.name));
  const scopes = new Set(manifest.policy.internalScopes);
  for (const name of names) if (name.startsWith('@')) scopes.add(name.split('/')[0]);
  for (const artifact of manifest.artifacts) names.add(artifact.manifest.name);
  return { names: [...names].sort(), scopes: [...scopes].sort() };
}

export function reconstructGraph(manifest, metadata) {
  const owned = ownership(manifest);
  const graph = new Map(manifest.artifacts.map((a) => [artifactKey(a), []]));
  const used = new Set();
  for (const artifact of manifest.artifacts) {
    const matches = manifest.artifacts.filter(
      (a) => a.manifest.name === artifact.manifest.name && a.origin === artifact.origin && isDeepStrictEqual(a.chain, artifact.chain)
    );
    demand(matches.length === 1, 'Ambiguous v1 edge source identity (no source digest)');
    const report = { diagnostics: [] };
    const recomputed = edges(artifact, report, artifact.chain || [artifact.manifest.name]);
    demand(!report.diagnostics.length, 'Packed dependency specifications failed inspection', 1);
    denyArtifact(manifest, artifact);
    for (const expected of recomputed) {
      const edge = bindEdge(manifest, expected, used, artifact);
      if (edge.devOnly) continue;
      demand(!edge.optionalPeer, 'Optional-peer absent/present adapter coverage required');
      const target = validateEdge(manifest, edge, owned);
      if (target) validateSelection(manifest, edge, target, metadata);
      if (target) graph.get(artifactKey(artifact)).push({ ...edge, target: artifactKey(target) });
    }
  }
  demand(used.size === manifest.edges.length, 'Unbound extra A graph edges');
  const candidates = manifest.artifacts.filter((a) => a.origin === 'candidate').map(artifactKey);
  dependencyOrder(graph, [...graph.keys()], new Set(candidates));
  return { owned, edges: Object.fromEntries(graph), candidates };
}

function validateSelection(manifest, edge, target, metadata) {
  const versions = metadata.get(edge.canonical)?.versions;
  demand(versions, 'Owned edge is missing registry metadata');
  const candidate = manifest.artifacts.find((a) => a.manifest.name === edge.canonical && a.origin === 'candidate');
  const intent = edge.sourceSpec?.startsWith('workspace:') || plannedCandidateEdge(manifest.releasePlan?.plan, edge);
  const local = intent && candidate && semver.satisfies(candidate.manifest.version, edge.range);
  const overlap = local && versions[candidate.manifest.version];
  if (local && !overlap) {
    demand(target === candidate, 'A candidate resolution identity changed');
    return;
  }
  const version = overlap ? candidate.manifest.version : semver.maxSatisfying(Object.keys(versions), edge.range);
  demand(target.origin === 'registry' || target.origin === 'fixture-registry', 'Registry-origin edge replaced with a candidate');
  demand(target.manifest.version === version, 'A registry version selection differs from bound metadata');
}

function denyArtifact(manifest, artifact) {
  const { name, version } = artifact.manifest;
  demand(!deniedVersions(manifest.policy, name).includes(version), 'Known-bad artifact identity', 1);
}

export function deniedVersions(policy, name) {
  return Object.hasOwn(policy.knownBad, name) ? policy.knownBad[name] : [];
}

function bindEdge(manifest, expected, used, artifact) {
  const matches = manifest.edges.filter(
    (edge) =>
      edge.package === expected.package &&
      edge.origin === expected.origin &&
      edge.field === expected.field &&
      edge.name === expected.name &&
      (!artifact.chain || isDeepStrictEqual(edge.chain, artifact.chain))
  );
  demand(matches.length === 1, 'Missing/ambiguous packed edge');
  const edge = matches[0];
  demand(!used.has(edge), 'Duplicate edge binding');
  used.add(edge);
  for (const key of ['spec', 'devOnly', 'canonical', 'range', 'optionalPeer']) {
    demand(isDeepStrictEqual(edge[key], expected[key]), 'A edge differs from packed dependency');
  }
  demand(
    edge.chain.length && (artifact.chain ? isDeepStrictEqual(edge.chain, artifact.chain) : edge.chain.at(-1) === artifact.manifest.name),
    'A edge origin chain mismatch'
  );
  if (edge.devOnly) demand(!edge.resolved && edge.resolution === 'dev-only hygiene; not production closure', 'Invalid dev edge');
  return edge;
}

function validateEdge(manifest, edge, owned) {
  const internal = owned.names.includes(edge.canonical) || owned.scopes.some((scope) => edge.canonical.startsWith(`${scope}/`));
  const workspace = manifest.workspaces.find((entry) => entry.name === edge.canonical);
  demand(
    !workspace || workspace.selection === 'candidate' || (manifest.schemaVersion === 2 && workspace.selection === 'not-selected'),
    'Withheld production dependency',
    1
  );
  demand(!deniedVersions(manifest.policy, edge.canonical).some((v) => semver.satisfies(v, edge.range)), 'Range admits known-bad artifact', 1);
  if (!internal) {
    demand(!edge.resolved && edge.resolution === 'external-unvalidated', 'Contradictory external edge');
    return null;
  }
  demand(edge.resolved && !edge.resolution, 'Unresolved owned dependency', 1);
  const target = manifest.artifacts.filter(
    (a) =>
      a.manifest.name === edge.resolved.name &&
      a.manifest.version === edge.resolved.version &&
      a.origin === edge.resolved.origin &&
      a.sha256 === edge.resolved.sha256 &&
      a.integrity === edge.resolved.integrity
  );
  demand(target.length === 1, 'Unbound/ambiguous resolved artifact');
  demand(edge.canonical === edge.resolved.name && semver.satisfies(edge.resolved.version, edge.range), 'Incompatible resolved owned dependency', 1);
  demand(target[0].origin !== 'held-audit', 'Held artifact cannot satisfy closure', 1);
  return target[0];
}

export function dependencyOrder(graph, roots, candidates = new Set()) {
  const active = new Set();
  const done = new Set();
  const result = [];
  function visit(key) {
    if (active.has(key)) {
      const cycle = [...active].slice([...active].indexOf(key));
      demand(false, 'Dependency cycle needs explicit bootstrap coverage', cycle.some((entry) => candidates.has(entry)) ? 1 : 2);
    }
    if (done.has(key)) return;
    demand(graph.has(key), 'Selected root is missing');
    active.add(key);
    for (const edge of graph.get(key)) visit(edge.target);
    active.delete(key);
    done.add(key);
    result.push(key);
  }
  for (const root of roots) visit(root);
  return result;
}

export function selectRoots(input, requested) {
  const candidates = input.artifacts.filter((a) => a.origins.includes('candidate')).map(artifactKey);
  const roots = requested.length ? [...new Set(requested)] : candidates;
  demand(roots.length > 0, 'No consumer roots selected');
  for (const root of roots)
    demand(
      input.artifacts.some((a) => artifactKey(a) === root && !a.origins.includes('held-audit')),
      'Root not in admitted inventory'
    );
  const order = dependencyOrder(new Map(Object.entries(input.graph.edges)), roots, new Set(input.graph.candidates));
  return { roots, unselected: input.artifacts.map(artifactKey).filter((key) => !roots.includes(key)), order };
}
