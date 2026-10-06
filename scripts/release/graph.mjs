import semver from 'semver';
import { plannedCandidateEdge } from './release-plan-schema.mjs';
import { edges } from './specs.mjs';
import { diagnostic } from './workspace.mjs';

export async function auditGraph(workspaces, artifacts, policy, registry, report) {
  const state = {
    workspaces: new Map(workspaces.map((entry) => [entry.name, entry])),
    local: new Map(artifacts.filter((entry) => entry.origin === 'candidate').map((entry) => [entry.manifest.name, entry])),
    policy,
    registry,
    report,
    visited: new Set(),
    proposals: new Map()
  };
  for (const artifact of artifacts) await auditRoot(state, artifact);
  checkCycles(state);
}

async function auditRoot(state, artifact) {
  const { name, version } = artifact.manifest;
  await visit(state, artifact, [name]);
  try {
    const metadata = await state.registry.metadata(name);
    if (Object.hasOwn(state.policy.knownBad, name) && state.policy.knownBad[name].includes(version)) {
      diagnostic(state.report, 'KNOWN_BAD_ARTIFACT', 'Fresh packing does not repair this denied public name/version', {
        package: name,
        version,
        origin: artifact.origin
      });
    }
    if (!metadata.versions[version]) return;
    const original = await state.registry.artifact(name, version, [`${name}@${version} (original registry root)`]);
    if (original) await visit(state, original, original.chain);
  } catch (error) {
    diagnostic(state.report, 'REGISTRY_INCOMPLETE', error.message, { package: name, version }, true);
  }
}

function owned(state, name) {
  return state.workspaces.has(name) || state.policy.internalScopes.some((scope) => name.startsWith(`${scope}/`));
}

async function visit(state, artifact, chain) {
  const key = `${artifact.origin}:${artifact.manifest.name}@${artifact.manifest.version}:${artifact.integrity}`;
  if (state.visited.has(key)) return;
  state.visited.add(key);
  for (const edge of edges(artifact, state.report, chain)) {
    state.report.edges.push(edge);
    if (edge.devOnly) {
      edge.resolution = 'dev-only hygiene; not production closure';
      continue;
    }
    if (!owned(state, edge.canonical)) {
      edge.resolution = 'external-unvalidated';
      continue;
    }
    try {
      await resolveEdge(state, edge, artifact);
    } catch (error) {
      diagnostic(state.report, 'REGISTRY_INCOMPLETE', error.message, edge, true);
    }
  }
}

function membership(state, edge) {
  const workspace = state.workspaces.get(edge.canonical);
  if (workspace?.selection === 'private' || workspace?.selection === 'held-audit') {
    diagnostic(state.report, 'WITHHELD_EDGE', `Public ${edge.field} targets ${workspace.selection} ${edge.canonical}; no approved fallback`, edge);
    edge.resolution = workspace.selection;
    return false;
  }
  return true;
}

async function resolveEdge(state, edge, artifact) {
  const eligible = membership(state, edge);
  const denied = Object.hasOwn(state.policy.knownBad, edge.canonical) ? state.policy.knownBad[edge.canonical] : [];
  const knownBad = denied.filter((version) => semver.satisfies(version, edge.range));
  if (knownBad.length) diagnostic(state.report, 'KNOWN_BAD_RANGE', `Range admits known-bad ${edge.canonical}@${knownBad.join(',')}`, edge);
  if (!eligible) {
    for (const version of knownBad) await resolveRegistry(state, edge, version);
    return;
  }
  const local = state.local.get(edge.canonical);
  const workspaceIntent = edge.sourceSpec?.startsWith('workspace:') || plannedCandidateEdge(state.report.releasePlan?.plan, edge);
  const localMatch = workspaceIntent && local && semver.satisfies(local.manifest.version, edge.range);
  if (localMatch && artifact.origin === 'candidate') propose(state, edge.package, edge.canonical);
  const metadata = await state.registry.metadata(edge.canonical);
  if (metadata.auditMissing && !localMatch && !edge.optionalPeer) throw new Error(`Registry 404 for required owned package ${edge.canonical}`);
  const publicMatch = semver.maxSatisfying(Object.keys(metadata.versions), edge.range);
  const overlap = localMatch && metadata.versions[local.manifest.version];
  const version = overlap ? local.manifest.version : publicMatch;
  if (localMatch && !overlap && !knownBad.length) {
    edge.resolved = resolution(local);
    await visit(state, local, [...edge.chain, edge.canonical]);
  } else if (version) {
    await resolveRegistry(state, edge, version);
  } else if (edge.optionalPeer && !local && Object.keys(metadata.versions).length === 0) {
    edge.resolution = 'optional-peer-absent; consumer behavior unvalidated';
  } else {
    diagnostic(state.report, 'UNSATISFIED', `No obtainable compatible owned version for ${edge.canonical}@${edge.range}`, edge);
  }
  for (const bad of knownBad.filter((v) => v !== version)) await resolveRegistry(state, { ...edge, policyEvidence: true }, bad);
}

function resolution(artifact) {
  return { name: artifact.manifest.name, version: artifact.manifest.version, origin: artifact.origin, integrity: artifact.integrity, sha256: artifact.sha256 };
}

async function resolveRegistry(state, edge, version) {
  const chain = [...edge.chain, `${edge.canonical}@${version} (original registry)`];
  const artifact = await state.registry.artifact(edge.canonical, version, chain);
  if (!artifact) return;
  edge.resolved = resolution(artifact);
  await visit(state, artifact, chain);
}

function propose(state, from, to) {
  if (!state.proposals.has(from)) state.proposals.set(from, new Set());
  state.proposals.get(from).add(to);
}

function checkCycles(state) {
  const complete = new Set();
  const active = new Set();
  const walk = (name, path) => {
    if (active.has(name)) {
      diagnostic(state.report, 'CANDIDATE_CYCLE', 'Proposed local candidates need a bootstrap plan', { chain: [...path, name] });
      return;
    }
    if (complete.has(name)) return;
    active.add(name);
    for (const child of state.proposals.get(name) || []) walk(child, [...path, name]);
    active.delete(name);
    complete.add(name);
  };
  for (const name of state.proposals.keys()) walk(name, []);
}
