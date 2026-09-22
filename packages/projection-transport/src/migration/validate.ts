import { isCanonicalProjectionUuid, isProjectionSha256Digest, validateProjectionQueueRegistryManifest } from '@redemeine/projection-runtime-core';
import { projectionMigrationDigest, projectionMigrationManifestPayload } from './digest';
import type { ProjectionMigrationManifest, ProjectionMigrationQuiesceEvidence, ProjectionMigrationReplayEvidence, ProjectionMigrationVerification } from './types';

const ROOT_KEYS = [
  'version', 'manifestDigest', 'migrationId', 'mode', 'oldRegistry', 'newRegistry', 'projectionName', 'oldGeneration', 'newGeneration', 'oldStrategy',
  'newStrategy', 'streamIdentity', 'transportStartAnchors', 'sourceCommitRanges', 'authoritativeBoundaryDigest', 'authoritativeSourceDigest', 'snapshot',
  'executableCodeDigest', 'runtimeConfigDigest', 'retainOldArtifacts'
] as const;
const RANGE_KEYS = ['sourceId', 'firstSequence', 'lastSequence', 'commitCount', 'completeCommitBoundaries', 'rangeDigest'] as const;
const SNAPSHOT_KEYS = ['boundaryDigest', 'stateDigest', 'linkDigest'] as const;
const REGISTRY_KEYS = ['version', 'manifestId', 'queueId', 'registryGeneration', 'identity', 'definitions', 'sourceStartAnchors'] as const;
const IDENTITY_KEYS = ['version', 'normalizedDefinitionRegistryDigest', 'normalizedRuntimeConfigurationDigest', 'executableCodeArtifactDigest'] as const;
const DEFINITION_KEYS = ['projectionName', 'generation', 'definitionHash', 'sourceSelectors'] as const;
const STRATEGIES = new Set(['in_document', 'own_record', 'none']);
const QUIESCE_KEYS = ['oldQueueDepth', 'oldActiveWriters', 'newActiveWriters', 'drainedAt', 'digest'] as const;
const REPLAY_KEYS = ['replayedRangesDigest', 'stateDigest', 'linkDigest', 'completedAt'] as const;
const VERIFY_KEYS = ['replayedRangesDigest', 'stateDigest', 'linkDigest', 'activeWriters', 'verifiedAt'] as const;

function record(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null) && Reflect.ownKeys(value).length === Object.keys(value).length;
}

function unknownKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): string[] {
  return Object.keys(value).filter((key) => !allowed.includes(key)).map((key) => `${path}.${key}.unknown`);
}

function nonempty(value: unknown): boolean {
  return typeof value === 'string' && value.trim() === value && value.length > 0;
}

function safeSequence(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function validateRanges(value: unknown, anchors: unknown): string[] {
  if (!Array.isArray(value) || !record(anchors)) return ['sourceCommitRanges'];
  const issues: string[] = [];
  const seen = new Set<string>();
  for (const [index, candidate] of value.entries()) {
    const path = `sourceCommitRanges[${index}]`;
    if (!record(candidate)) { issues.push(path); continue; }
    issues.push(...unknownKeys(candidate, RANGE_KEYS, path));
    const sourceId = candidate.sourceId;
    if (!isCanonicalProjectionUuid(sourceId) || seen.has(String(sourceId))) issues.push(`${path}.sourceId`);
    seen.add(String(sourceId));
    if (!safeSequence(candidate.firstSequence) || !safeSequence(candidate.lastSequence)) issues.push(`${path}.sequence`);
    if (!safeSequence(candidate.commitCount) || candidate.commitCount === 0) issues.push(`${path}.commitCount`);
    if (candidate.completeCommitBoundaries !== true) issues.push(`${path}.completeCommitBoundaries`);
    if (!isProjectionSha256Digest(candidate.rangeDigest)) issues.push(`${path}.rangeDigest`);
    if (safeSequence(candidate.firstSequence) && safeSequence(candidate.lastSequence) && safeSequence(candidate.commitCount)
      && candidate.lastSequence - candidate.firstSequence + 1 !== candidate.commitCount) issues.push(`${path}.contiguous`);
    if (record(anchors) && anchors[String(sourceId)] !== candidate.firstSequence) issues.push(`${path}.startAnchor`);
  }
  if (seen.size !== Object.keys(anchors).length) issues.push('sourceCommitRanges.coverage');
  return issues;
}

function validateRegistryUnknowns(value: unknown, path: string): string[] {
  if (!record(value)) return [];
  const issues = unknownKeys(value, REGISTRY_KEYS, path);
  if (record(value.identity)) issues.push(...unknownKeys(value.identity, IDENTITY_KEYS, `${path}.identity`));
  if (Array.isArray(value.definitions)) {
    for (const [index, definition] of value.definitions.entries()) {
      if (record(definition)) issues.push(...unknownKeys(definition, DEFINITION_KEYS, `${path}.definitions[${index}]`));
    }
  }
  return issues;
}

function validateSnapshot(value: unknown, boundary: unknown, required: boolean): string[] {
  if (value === null) return required ? ['snapshot.required'] : [];
  if (!record(value)) return ['snapshot'];
  const issues = unknownKeys(value, SNAPSHOT_KEYS, 'snapshot');
  for (const key of SNAPSHOT_KEYS) if (!isProjectionSha256Digest(value[key])) issues.push(`snapshot.${key}`);
  if (value.boundaryDigest !== boundary) issues.push('snapshot.boundaryDigest.mismatch');
  return issues;
}

export function validateProjectionMigrationManifest(candidate: unknown): readonly string[] {
  if (!record(candidate)) return ['manifest'];
  const issues = unknownKeys(candidate, ROOT_KEYS, 'manifest');
  if (candidate.version !== 1) issues.push('version');
  for (const key of ['manifestDigest', 'authoritativeBoundaryDigest', 'authoritativeSourceDigest', 'executableCodeDigest', 'runtimeConfigDigest']) {
    if (!isProjectionSha256Digest(candidate[key])) issues.push(key);
  }
  for (const key of ['migrationId', 'projectionName', 'oldGeneration', 'newGeneration']) if (!nonempty(candidate[key])) issues.push(key);
  if (candidate.mode !== 'rebuild' && candidate.mode !== 'in_place') issues.push('mode');
  if (!STRATEGIES.has(String(candidate.oldStrategy)) || !STRATEGIES.has(String(candidate.newStrategy))) issues.push('strategy');
  if (candidate.streamIdentity !== 'immutable_uuid_no_reset') issues.push('streamIdentity');
  if (candidate.retainOldArtifacts !== true) issues.push('retainOldArtifacts');
  issues.push(...validateProjectionQueueRegistryManifest(candidate.oldRegistry));
  issues.push(...validateProjectionQueueRegistryManifest(candidate.newRegistry));
  issues.push(...validateRegistryUnknowns(candidate.oldRegistry, 'oldRegistry'));
  issues.push(...validateRegistryUnknowns(candidate.newRegistry, 'newRegistry'));
  issues.push(...validateRanges(candidate.sourceCommitRanges, candidate.transportStartAnchors));
  issues.push(...validateSnapshot(candidate.snapshot, candidate.authoritativeBoundaryDigest, candidate.mode === 'in_place'));
  if (candidate.mode === 'rebuild' && candidate.oldGeneration === candidate.newGeneration) issues.push('newGeneration.required');
  if (candidate.mode === 'in_place' && candidate.oldGeneration !== candidate.newGeneration) issues.push('inPlace.generation');
  if (candidate.oldStrategy !== candidate.newStrategy && candidate.oldGeneration === candidate.newGeneration) issues.push('strategyChange.requiresNewGeneration');
  if (record(candidate.newRegistry) && JSON.stringify(candidate.transportStartAnchors) !== JSON.stringify(candidate.newRegistry.sourceStartAnchors)) {
    issues.push('transportStartAnchors.newRegistryMismatch');
  }
  if (Array.isArray(candidate.sourceCommitRanges)) {
    const sourceDigest = projectionMigrationDigest(candidate.sourceCommitRanges);
    if (candidate.authoritativeSourceDigest !== sourceDigest) issues.push('authoritativeSourceDigest.mismatch');
    if (candidate.authoritativeBoundaryDigest !== sourceDigest) issues.push('authoritativeBoundaryDigest.mismatch');
  }
  if (isProjectionSha256Digest(candidate.manifestDigest)
    && projectionMigrationDigest(projectionMigrationManifestPayload(candidate)) !== candidate.manifestDigest) issues.push('manifestDigest.mismatch');
  return [...new Set(issues)];
}

export function parseProjectionMigrationManifest(candidate: unknown): ProjectionMigrationManifest {
  const issues = validateProjectionMigrationManifest(candidate);
  if (issues.length > 0) throw new Error(`Invalid projection migration manifest: ${issues.join(',')}`);
  return candidate as ProjectionMigrationManifest;
}

function isIsoDate(value: unknown): boolean {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

export function parseProjectionMigrationQuiesceEvidence(candidate: unknown): ProjectionMigrationQuiesceEvidence {
  if (!record(candidate)) throw new Error('Invalid quiesce evidence.');
  const issues = unknownKeys(candidate, QUIESCE_KEYS, 'quiesce');
  if (candidate.oldQueueDepth !== 0 || candidate.oldActiveWriters !== 0 || candidate.newActiveWriters !== 0) issues.push('quiesce.notDrained');
  if (!isIsoDate(candidate.drainedAt) || !isProjectionSha256Digest(candidate.digest)) issues.push('quiesce.evidence');
  const payload = { oldQueueDepth: candidate.oldQueueDepth, oldActiveWriters: candidate.oldActiveWriters,
    newActiveWriters: candidate.newActiveWriters, drainedAt: candidate.drainedAt };
  if (isProjectionSha256Digest(candidate.digest) && projectionMigrationDigest(payload) !== candidate.digest) issues.push('quiesce.digestMismatch');
  if (issues.length) throw new Error(`Invalid quiesce evidence: ${issues.join(',')}`);
  return candidate as unknown as ProjectionMigrationQuiesceEvidence;
}

function parseReplayLike(candidate: unknown, verification: boolean): ProjectionMigrationReplayEvidence | ProjectionMigrationVerification {
  if (!record(candidate)) throw new Error('Invalid replay evidence.');
  const keys = verification ? VERIFY_KEYS : REPLAY_KEYS;
  const issues = unknownKeys(candidate, keys, verification ? 'verification' : 'replay');
  for (const key of ['replayedRangesDigest', 'stateDigest', 'linkDigest']) if (!isProjectionSha256Digest(candidate[key])) issues.push(key);
  if (!isIsoDate(candidate[verification ? 'verifiedAt' : 'completedAt'])) issues.push('timestamp');
  if (verification && candidate.activeWriters !== 1) issues.push('activeWriters');
  if (issues.length) throw new Error(`Invalid replay evidence: ${issues.join(',')}`);
  return candidate as unknown as ProjectionMigrationReplayEvidence | ProjectionMigrationVerification;
}

export function parseProjectionMigrationReplayEvidence(candidate: unknown): ProjectionMigrationReplayEvidence {
  return parseReplayLike(candidate, false) as ProjectionMigrationReplayEvidence;
}

export function parseProjectionMigrationVerification(candidate: unknown): ProjectionMigrationVerification {
  return parseReplayLike(candidate, true) as ProjectionMigrationVerification;
}
