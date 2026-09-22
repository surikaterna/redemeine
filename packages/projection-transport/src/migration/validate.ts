import { isCanonicalProjectionUuid, isProjectionSha256Digest, validateProjectionQueueRegistryManifest } from '@redemeine/projection-runtime-core';
import { ProjectionMigrationStreamingDigest, projectionMigrationDigest, projectionMigrationManifestPayload } from './digest';
import type { ProjectionMigrationManifest, ProjectionMigrationSourceRange } from './types';

export const PROJECTION_MIGRATION_MAX_RANGES = 10_000;
export const PROJECTION_MIGRATION_MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const ROOT_KEYS = [
  'version',
  'manifestDigest',
  'migrationId',
  'projectionName',
  'oldGeneration',
  'newGeneration',
  'destinationStrategies',
  'streamIdentity',
  'oldRegistry',
  'newRegistry',
  'sourceRanges',
  'authoritativeSourceDigest'
] as const;
const RANGE_KEYS = ['sourceId', 'firstSequence', 'lastSequence', 'commitCount', 'expectedDigest'] as const;
const STRATEGIES = new Set(['in_document', 'own_record', 'none']);

function record(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null) && Reflect.ownKeys(value).length === Object.keys(value).length;
}

function unknownKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): string[] {
  return Object.keys(value)
    .filter((key) => !allowed.includes(key))
    .map((key) => `${path}.${key}.unknown`);
}

function sequence(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

export function projectionMigrationRangeKey(range: ProjectionMigrationSourceRange): string {
  return `${range.sourceId}:${range.firstSequence}:${range.lastSequence}`;
}

export function projectionMigrationSourceDescriptorDigest(ranges: readonly ProjectionMigrationSourceRange[]): `sha256:${string}` {
  const digest = new ProjectionMigrationStreamingDigest('redemeine:migration:source-descriptors:v2');
  for (const range of ranges) digest.update(range);
  return digest.finish().digest;
}

function validateRanges(value: unknown): { issues: string[]; ranges: ProjectionMigrationSourceRange[] } {
  if (!Array.isArray(value)) return { issues: ['sourceRanges'], ranges: [] };
  const issues: string[] = value.length > PROJECTION_MIGRATION_MAX_RANGES ? ['sourceRanges.unsupportedBound'] : [];
  if (value.length === 0) issues.push('sourceRanges.empty');
  const ranges: ProjectionMigrationSourceRange[] = [];
  for (const [index, candidate] of value.entries()) {
    const path = `sourceRanges[${index}]`;
    if (!record(candidate)) {
      issues.push(path);
      continue;
    }
    issues.push(...unknownKeys(candidate, RANGE_KEYS, path));
    if (!isCanonicalProjectionUuid(candidate.sourceId)) issues.push(`${path}.sourceId`);
    if (!sequence(candidate.firstSequence) || !sequence(candidate.lastSequence) || candidate.lastSequence < candidate.firstSequence)
      issues.push(`${path}.sequence`);
    if (!sequence(candidate.commitCount) || candidate.commitCount !== Number(candidate.lastSequence) - Number(candidate.firstSequence) + 1)
      issues.push(`${path}.commitCount`);
    if (!isProjectionSha256Digest(candidate.expectedDigest)) issues.push(`${path}.expectedDigest`);
    if (
      isCanonicalProjectionUuid(candidate.sourceId) &&
      sequence(candidate.firstSequence) &&
      sequence(candidate.lastSequence) &&
      sequence(candidate.commitCount) &&
      isProjectionSha256Digest(candidate.expectedDigest)
    )
      ranges.push(candidate as unknown as ProjectionMigrationSourceRange);
  }
  for (const [index, range] of ranges.entries()) {
    if ((index === 0 || ranges[index - 1]?.sourceId !== range.sourceId) && range.firstSequence !== 0) issues.push(`sourceRanges[${index}].mustStartAtZero`);
  }
  for (let index = 1; index < ranges.length; index += 1) validateRangeOrder(ranges[index - 1]!, ranges[index]!, issues, index);
  return { issues, ranges };
}

function validateRangeOrder(previous: ProjectionMigrationSourceRange, current: ProjectionMigrationSourceRange, issues: string[], index: number): void {
  const ordered = previous.sourceId < current.sourceId || (previous.sourceId === current.sourceId && previous.firstSequence < current.firstSequence);
  if (!ordered) issues.push(`sourceRanges[${index}].order`);
  if (previous.sourceId === current.sourceId && current.firstSequence !== previous.lastSequence + 1) issues.push(`sourceRanges[${index}].contiguous`);
}

function validateAnchors(candidate: Record<string, unknown>, ranges: readonly ProjectionMigrationSourceRange[]): string[] {
  if (!record(candidate.newRegistry)) return [];
  const anchors = record(candidate.newRegistry.sourceStartAnchors) ? candidate.newRegistry.sourceStartAnchors : {};
  const ends = new Map<string, number>();
  for (const range of ranges) ends.set(range.sourceId, range.lastSequence);
  const issues: string[] = [];
  if (Object.keys(anchors).length !== ends.size) issues.push('newRegistry.sourceStartAnchors.coverage');
  for (const [sourceId, lastSequence] of ends) if (anchors[sourceId] !== lastSequence + 1) issues.push(`newRegistry.sourceStartAnchors.${sourceId}`);
  return issues;
}

export function validateProjectionMigrationManifest(candidate: unknown, encodedBytes?: number): readonly string[] {
  if (!record(candidate)) return ['manifest'];
  const issues = unknownKeys(candidate, ROOT_KEYS, 'manifest');
  if (encodedBytes !== undefined && encodedBytes > PROJECTION_MIGRATION_MAX_MANIFEST_BYTES) issues.push('manifest.unsupportedBound');
  if (candidate.version !== 2) issues.push('version');
  if (typeof candidate.migrationId !== 'string' || candidate.migrationId.length === 0) issues.push('migrationId');
  if (typeof candidate.projectionName !== 'string' || candidate.projectionName.length === 0) issues.push('projectionName');
  if (typeof candidate.oldGeneration !== 'string' || typeof candidate.newGeneration !== 'string' || candidate.oldGeneration === candidate.newGeneration)
    issues.push('freshGeneration');
  if (!record(candidate.destinationStrategies)) issues.push('destinationStrategies');
  const definitions = record(candidate.newRegistry) && Array.isArray(candidate.newRegistry.definitions) ? candidate.newRegistry.definitions : [];
  const definitionNames = definitions.flatMap((definition) =>
    record(definition) && typeof definition.projectionName === 'string' ? [definition.projectionName] : []
  );
  if (record(candidate.destinationStrategies)) {
    if (Object.keys(candidate.destinationStrategies).length !== definitionNames.length) issues.push('destinationStrategies.coverage');
    for (const name of definitionNames) if (!STRATEGIES.has(String(candidate.destinationStrategies[name]))) issues.push(`destinationStrategies.${name}`);
    for (const name of Object.keys(candidate.destinationStrategies)) if (!definitionNames.includes(name)) issues.push(`destinationStrategies.${name}.unknown`);
  }
  if (candidate.streamIdentity !== 'immutable_uuid_no_reset') issues.push('streamIdentity');
  if (!isProjectionSha256Digest(candidate.manifestDigest)) issues.push('manifestDigest');
  if (!isProjectionSha256Digest(candidate.authoritativeSourceDigest)) issues.push('authoritativeSourceDigest');
  issues.push(...validateProjectionQueueRegistryManifest(candidate.oldRegistry), ...validateProjectionQueueRegistryManifest(candidate.newRegistry));
  validateRegistryDigest(candidate.oldRegistry, 'oldRegistry', issues);
  validateRegistryDigest(candidate.newRegistry, 'newRegistry', issues);
  const validated = validateRanges(candidate.sourceRanges);
  issues.push(...validated.issues, ...validateAnchors(candidate, validated.ranges));
  if (validated.ranges.length && candidate.authoritativeSourceDigest !== projectionMigrationSourceDescriptorDigest(validated.ranges))
    issues.push('authoritativeSourceDigest.mismatch');
  if (
    isProjectionSha256Digest(candidate.manifestDigest) &&
    projectionMigrationDigest(projectionMigrationManifestPayload(candidate), 'redemeine:migration:manifest:v2') !== candidate.manifestDigest
  )
    issues.push('manifestDigest.mismatch');
  return [...new Set(issues)];
}

function validateRegistryDigest(value: unknown, path: string, issues: string[]): void {
  if (!record(value) || !isProjectionSha256Digest(value.manifestId) || !Array.isArray(value.definitions)) return;
  const { manifestId: _, ...payload } = value;
  if (projectionMigrationDigest(payload, 'redemeine:projection:queue-registry:v1') !== value.manifestId) {
    issues.push(`${path}.manifestId.mismatch`);
  }
  if (
    record(value.identity) &&
    isProjectionSha256Digest(value.identity.normalizedDefinitionRegistryDigest) &&
    projectionMigrationDigest(value.definitions, 'redemeine:projection:definition-registry:v1') !== value.identity.normalizedDefinitionRegistryDigest
  )
    issues.push(`${path}.identity.normalizedDefinitionRegistryDigest.mismatch`);
}

export function parseProjectionMigrationManifest(candidate: unknown, encodedBytes?: number): ProjectionMigrationManifest {
  const issues = validateProjectionMigrationManifest(candidate, encodedBytes);
  if (issues.length) throw new Error(`Invalid projection migration manifest: ${issues.join(',')}`);
  return candidate as ProjectionMigrationManifest;
}
