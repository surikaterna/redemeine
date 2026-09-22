import {
  isProjectionSha256Digest,
  type ProjectionDeduplicationStrategy,
  type ProjectionQueueRegistryManifest,
  type ProjectionRegistryManifestIdentity
} from '@redemeine/projection-runtime-core';
import type { ProjectionCommitRegistryDefinition } from '@redemeine/projection-worker-core';
import { projectionMigrationDigest } from './digest';
import type { ProjectionMigrationStrategy } from './types';

export interface ProjectionMigrationRuntimeDefinition {
  readonly projectionName: string;
  readonly generation: string;
  readonly definitionHash: `sha256:${string}`;
  readonly sourceSelectors: readonly string[];
  readonly deduplication: ProjectionDeduplicationStrategy;
}

export interface ProjectionMigrationRuntimeIdentity {
  readonly version: 1;
  readonly queueId: string;
  readonly registryGeneration: string;
  readonly identity: ProjectionRegistryManifestIdentity;
  readonly definitions: readonly ProjectionMigrationRuntimeDefinition[];
  readonly registryDigest: `sha256:${string}`;
}

export interface ProjectionMigrationRuntimeModule {
  readonly migrationDefinitions: readonly ProjectionCommitRegistryDefinition<unknown>[];
  readonly migrationRuntimeIdentity: ProjectionMigrationRuntimeIdentity;
}

const ROOT_KEYS = ['version', 'queueId', 'registryGeneration', 'identity', 'definitions', 'registryDigest'] as const;
const IDENTITY_KEYS = ['version', 'normalizedDefinitionRegistryDigest', 'normalizedRuntimeConfigurationDigest', 'executableCodeArtifactDigest'] as const;
const DEFINITION_KEYS = ['projectionName', 'generation', 'definitionHash', 'sourceSelectors', 'deduplication'] as const;

export function projectionDefinitionRegistryDigest(definitions: ProjectionQueueRegistryManifest['definitions']): `sha256:${string}` {
  return projectionMigrationDigest(definitions, 'redemeine:projection:definition-registry:v1');
}

export function projectionQueueRegistryDigest(manifest: Omit<ProjectionQueueRegistryManifest, 'manifestId'>): `sha256:${string}` {
  return projectionMigrationDigest(manifest, 'redemeine:projection:queue-registry:v1');
}

export function projectionMigrationRuntimeRegistryDigest(identity: Omit<ProjectionMigrationRuntimeIdentity, 'registryDigest'>): `sha256:${string}` {
  return projectionMigrationDigest(identity, 'redemeine:migration:runtime-registry:v1');
}

export function parseProjectionMigrationRuntimeModule(value: unknown): ProjectionMigrationRuntimeModule {
  if (!moduleRecord(value) || unknownKeys(value, ['migrationDefinitions', 'migrationRuntimeIdentity']).length) {
    throw new Error('Runtime module must export only canonical migration material.');
  }
  if (!Array.isArray(value.migrationDefinitions)) throw new Error('Runtime module must export migrationDefinitions.');
  const identity = parseIdentity(value.migrationRuntimeIdentity);
  assertExecutableDefinitions(value.migrationDefinitions, identity);
  return { migrationDefinitions: value.migrationDefinitions, migrationRuntimeIdentity: identity };
}

export function assertRuntimeMatchesManifest(
  runtime: ProjectionMigrationRuntimeIdentity,
  manifest: ProjectionQueueRegistryManifest,
  strategies: Readonly<Record<string, ProjectionMigrationStrategy>>,
  launchedArtifactDigest: string
): void {
  const declared = runtime.definitions.map(({ deduplication: _, ...definition }) => definition);
  if (
    runtime.queueId !== manifest.queueId ||
    runtime.registryGeneration !== manifest.registryGeneration ||
    !equal(runtime.identity, manifest.identity) ||
    !equal(declared, manifest.definitions) ||
    runtime.registryDigest !== projectionMigrationRuntimeRegistryDigest(withoutDigest(runtime)) ||
    manifest.manifestId !== projectionQueueRegistryDigest(withoutManifestId(manifest)) ||
    manifest.identity.normalizedDefinitionRegistryDigest !== projectionDefinitionRegistryDigest(manifest.definitions)
  ) {
    throw new Error('Runtime registry identity does not match the canonical immutable manifest.');
  }
  if (launchedArtifactDigest !== runtime.identity.executableCodeArtifactDigest) throw new Error('Launcher executable artifact digest mismatch.');
  const runtimeStrategies = Object.fromEntries(runtime.definitions.map((entry) => [entry.projectionName, entry.deduplication.strategy]));
  if (!equal(runtimeStrategies, strategies)) throw new Error('Runtime deduplication configuration does not match the migration manifest.');
}

function parseIdentity(value: unknown): ProjectionMigrationRuntimeIdentity {
  if (
    !record(value) ||
    unknownKeys(value, ROOT_KEYS).length ||
    value.version !== 1 ||
    typeof value.queueId !== 'string' ||
    typeof value.registryGeneration !== 'string' ||
    !isProjectionSha256Digest(value.registryDigest)
  )
    throw new Error('Invalid migrationRuntimeIdentity.');
  const identity = value.identity;
  const definitions = value.definitions;
  if (
    !record(identity) ||
    unknownKeys(identity, IDENTITY_KEYS).length ||
    identity.version !== 1 ||
    !isProjectionSha256Digest(identity.normalizedDefinitionRegistryDigest) ||
    !isProjectionSha256Digest(identity.normalizedRuntimeConfigurationDigest) ||
    !isProjectionSha256Digest(identity.executableCodeArtifactDigest) ||
    !Array.isArray(definitions)
  )
    throw new Error('Invalid runtime identity material.');
  const parsedDefinitions = definitions.map(validateDefinition);
  return {
    version: 1,
    queueId: value.queueId,
    registryGeneration: value.registryGeneration,
    identity: {
      version: 1,
      normalizedDefinitionRegistryDigest: identity.normalizedDefinitionRegistryDigest,
      normalizedRuntimeConfigurationDigest: identity.normalizedRuntimeConfigurationDigest,
      executableCodeArtifactDigest: identity.executableCodeArtifactDigest
    },
    definitions: parsedDefinitions,
    registryDigest: value.registryDigest
  };
}

function validateDefinition(value: unknown): ProjectionMigrationRuntimeDefinition {
  if (
    !record(value) ||
    unknownKeys(value, DEFINITION_KEYS).length ||
    typeof value.projectionName !== 'string' ||
    typeof value.generation !== 'string' ||
    !isProjectionSha256Digest(value.definitionHash) ||
    !Array.isArray(value.sourceSelectors) ||
    !value.sourceSelectors.every((selector) => typeof selector === 'string')
  )
    throw new Error('Invalid runtime definition identity.');
  const deduplication = parseDeduplication(value.deduplication);
  return {
    projectionName: value.projectionName,
    generation: value.generation,
    definitionHash: value.definitionHash,
    sourceSelectors: value.sourceSelectors,
    deduplication
  };
}

function parseDeduplication(value: unknown): ProjectionDeduplicationStrategy {
  if (!record(value)) throw new Error('Invalid runtime deduplication identity.');
  if (
    value.strategy === 'none' &&
    value.duplicateEffects === 'acknowledged' &&
    typeof value.reason === 'string' &&
    !unknownKeys(value, ['strategy', 'duplicateEffects', 'reason']).length
  )
    return { strategy: 'none', duplicateEffects: 'acknowledged', reason: value.reason };
  if ((value.strategy === 'in_document' || value.strategy === 'own_record') && !unknownKeys(value, ['strategy', 'warnings']).length) {
    const warnings = parseWarnings(value.warnings);
    return warnings ? { strategy: value.strategy, warnings } : { strategy: value.strategy };
  }
  throw new Error('Invalid runtime deduplication identity.');
}

function parseWarnings(value: unknown): { warnAtSourceCount?: number; warnAtMetadataBytes?: number } | undefined {
  if (value === undefined) return undefined;
  if (!record(value) || unknownKeys(value, ['warnAtSourceCount', 'warnAtMetadataBytes']).length) throw new Error('Invalid deduplication warnings.');
  const result: { warnAtSourceCount?: number; warnAtMetadataBytes?: number } = {};
  if (value.warnAtSourceCount !== undefined) {
    if (!Number.isSafeInteger(value.warnAtSourceCount)) throw new Error('Invalid deduplication warnings.');
    result.warnAtSourceCount = Number(value.warnAtSourceCount);
  }
  if (value.warnAtMetadataBytes !== undefined) {
    if (!Number.isSafeInteger(value.warnAtMetadataBytes)) throw new Error('Invalid deduplication warnings.');
    result.warnAtMetadataBytes = Number(value.warnAtMetadataBytes);
  }
  return result;
}

function assertExecutableDefinitions(
  values: readonly unknown[],
  identity: ProjectionMigrationRuntimeIdentity
): asserts values is readonly ProjectionCommitRegistryDefinition<unknown>[] {
  if (values.length !== identity.definitions.length) throw new Error('Runtime executable definition coverage mismatch.');
  for (const [index, value] of values.entries()) {
    if (!record(value) || typeof value.generation !== 'string' || !record(value.definition)) throw new Error('Invalid executable runtime definition.');
    const expected = identity.definitions[index]!;
    const definition = value.definition;
    const selector = record(definition.fromStream) && record(definition.fromStream.aggregate) ? definition.fromStream.aggregate.aggregateType : undefined;
    if (
      value.generation !== expected.generation ||
      definition.name !== expected.projectionName ||
      !equal([selector], expected.sourceSelectors) ||
      !equal(definition.deduplication, expected.deduplication)
    ) {
      throw new Error('Executable runtime definitions do not match declared identity material.');
    }
  }
}

function withoutDigest(value: ProjectionMigrationRuntimeIdentity): Omit<ProjectionMigrationRuntimeIdentity, 'registryDigest'> {
  const { registryDigest: _, ...payload } = value;
  return payload;
}
function withoutManifestId(value: ProjectionQueueRegistryManifest): Omit<ProjectionQueueRegistryManifest, 'manifestId'> {
  const { manifestId: _, ...payload } = value;
  return payload;
}
function record(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null) && Reflect.ownKeys(value).length === Object.keys(value).length;
}
function moduleRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function unknownKeys(value: Record<string, unknown>, allowed: readonly string[]): string[] {
  return Object.keys(value).filter((key) => !allowed.includes(key));
}
function equal(left: unknown, right: unknown): boolean {
  return projectionMigrationDigest(left) === projectionMigrationDigest(right);
}
