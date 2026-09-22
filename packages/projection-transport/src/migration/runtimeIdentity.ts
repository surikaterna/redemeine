import {
  type ProjectionDeduplicationStrategy,
  type ProjectionQueueRegistryManifest,
  type ProjectionRegistryDefinitionManifest,
  type ProjectionRegistryManifestIdentity
} from '@redemeine/projection-runtime-core';
import type { ProjectionCommitRegistryDefinition } from '@redemeine/projection-worker-core';
import { projectionMigrationDigest } from './digest';
import type { ProjectionMigrationStrategy } from './types';

export interface ProjectionMigrationStreamConfiguration {
  readonly aggregateType: string;
  readonly aggregateKeys: readonly string[];
  readonly aggregatePureKeys: readonly string[];
  readonly aggregateEventProjectorKeys: readonly string[];
  readonly handlerKeys: readonly string[];
}
export interface ProjectionMigrationDeploymentDefinition {
  readonly projectionName: string;
  readonly generation: string;
  readonly from: ProjectionMigrationStreamConfiguration;
  readonly joins: readonly ProjectionMigrationStreamConfiguration[];
  readonly reverseSubscriptions: readonly ProjectionMigrationStreamConfiguration[];
  readonly subscriptions: readonly { aggregateType: string; aggregateId: string }[];
  readonly deduplication: ProjectionDeduplicationStrategy;
  readonly hookKeys: readonly string[];
  readonly identityConfiguration: unknown;
}
export interface ProjectionMigrationRuntimeModule {
  readonly migrationDefinitions: readonly ProjectionCommitRegistryDefinition<unknown>[];
  readonly migrationDeploymentDefinitions: readonly ProjectionMigrationDeploymentDefinition[];
}

export function projectionDefinitionRegistryDigest(definitions: readonly ProjectionRegistryDefinitionManifest[]): `sha256:${string}` {
  return projectionMigrationDigest(definitions, 'redemeine:projection:definition-registry:v1');
}
export function projectionQueueRegistryDigest(manifest: Omit<ProjectionQueueRegistryManifest, 'manifestId'>): `sha256:${string}` {
  return projectionMigrationDigest(manifest, 'redemeine:projection:queue-registry:v1');
}
export function projectionMigrationDefinitionHash(
  configuration: ProjectionMigrationDeploymentDefinition,
  artifactDigest: `sha256:${string}`
): `sha256:${string}` {
  return projectionMigrationDigest({ configuration, artifactDigest }, 'redemeine:migration:definition:v2');
}
export function projectionMigrationRuntimeConfigurationDigest(configurations: readonly ProjectionMigrationDeploymentDefinition[]): `sha256:${string}` {
  return projectionMigrationDigest(configurations, 'redemeine:migration:runtime-configuration:v2');
}

export function parseProjectionMigrationRuntimeModule(value: unknown): ProjectionMigrationRuntimeModule {
  if (!moduleRecord(value) || unknownKeys(value, ['migrationDefinitions', 'migrationDeploymentDefinitions']).length) {
    throw new Error('Runtime bundle must export only migrationDefinitions and migrationDeploymentDefinitions.');
  }
  if (!Array.isArray(value.migrationDefinitions) || !Array.isArray(value.migrationDeploymentDefinitions)) {
    throw new Error('Runtime bundle exports are incomplete.');
  }
  const declared = value.migrationDeploymentDefinitions.map(parseDeploymentDefinition);
  assertExecutableDefinitions(value.migrationDefinitions, declared);
  return { migrationDefinitions: value.migrationDefinitions, migrationDeploymentDefinitions: declared };
}

export function assertRuntimeMatchesManifest(
  runtime: ProjectionMigrationRuntimeModule,
  manifest: ProjectionQueueRegistryManifest,
  strategies: Readonly<Record<string, ProjectionMigrationStrategy>>,
  artifactDigest: `sha256:${string}`
): void {
  const definitions = runtime.migrationDeploymentDefinitions.map<ProjectionRegistryDefinitionManifest>((configuration) => ({
    projectionName: configuration.projectionName,
    generation: configuration.generation,
    definitionHash: projectionMigrationDefinitionHash(configuration, artifactDigest),
    sourceSelectors: sourceSelectors(configuration)
  }));
  const identity: ProjectionRegistryManifestIdentity = {
    version: 1,
    normalizedDefinitionRegistryDigest: projectionDefinitionRegistryDigest(definitions),
    normalizedRuntimeConfigurationDigest: projectionMigrationRuntimeConfigurationDigest(runtime.migrationDeploymentDefinitions),
    executableCodeArtifactDigest: artifactDigest
  };
  if (
    !equal(definitions, manifest.definitions) ||
    !equal(identity, manifest.identity) ||
    manifest.manifestId !== projectionQueueRegistryDigest(withoutManifestId(manifest))
  ) {
    throw new Error('Runtime bundle identity does not match the canonical immutable manifest.');
  }
  const actualStrategies = Object.fromEntries(runtime.migrationDeploymentDefinitions.map((entry) => [entry.projectionName, entry.deduplication.strategy]));
  if (!equal(actualStrategies, strategies)) throw new Error('Runtime deduplication configuration does not match the migration manifest.');
}

export function normalizeProjectionMigrationDefinitions<TState>(
  values: readonly ProjectionCommitRegistryDefinition<TState>[],
  identityConfigurations: readonly unknown[]
): readonly ProjectionMigrationDeploymentDefinition[] {
  if (values.length !== identityConfigurations.length) throw new Error('Identity configuration coverage mismatch.');
  return values.map((entry, index) => normalizeDefinition(entry, identityConfigurations[index]));
}

function normalizeDefinition<TState>(
  entry: ProjectionCommitRegistryDefinition<TState>,
  identityConfiguration: unknown
): ProjectionMigrationDeploymentDefinition {
  const definition = entry.definition;
  return {
    projectionName: definition.name,
    generation: entry.generation,
    from: normalizeStream(definition.fromStream),
    joins: (definition.joinStreams ?? []).map(normalizeStream),
    reverseSubscriptions: (definition.reverseSubscribeStreams ?? []).map(normalizeStream),
    subscriptions: definition.subscriptions.map((value) => ({ aggregateType: value.aggregate.aggregateType, aggregateId: value.aggregateId })),
    deduplication: definition.deduplication,
    hookKeys: Object.keys(definition.hooks ?? {}).sort(),
    identityConfiguration
  };
}
function normalizeStream(value: { aggregate: { aggregateType: string }; handlers: Record<string, unknown> }): ProjectionMigrationStreamConfiguration {
  const aggregate = value.aggregate as { aggregateType: string; pure?: unknown };
  const pure = record(aggregate.pure) ? aggregate.pure : {};
  const projectors = record(pure.eventProjectors) ? pure.eventProjectors : {};
  return {
    aggregateType: aggregate.aggregateType,
    aggregateKeys: Object.keys(aggregate).sort(),
    aggregatePureKeys: Object.keys(pure).sort(),
    aggregateEventProjectorKeys: Object.keys(projectors).sort(),
    handlerKeys: Object.keys(value.handlers).sort()
  };
}
function sourceSelectors(value: ProjectionMigrationDeploymentDefinition): readonly string[] {
  return [
    ...new Set([
      value.from.aggregateType,
      ...value.joins.map((entry) => entry.aggregateType),
      ...value.reverseSubscriptions.map((entry) => entry.aggregateType)
    ])
  ].sort();
}

function assertExecutableDefinitions(
  values: readonly unknown[],
  declared: readonly ProjectionMigrationDeploymentDefinition[]
): asserts values is readonly ProjectionCommitRegistryDefinition<unknown>[] {
  if (values.length !== declared.length) throw new Error('Runtime executable definition coverage mismatch.');
  if (!values.every(isExecutableDefinition)) throw new Error('Invalid executable runtime definition.');
  const normalized = normalizeProjectionMigrationDefinitions(
    values,
    declared.map((entry) => entry.identityConfiguration)
  );
  if (!equal(normalized, declared)) throw new Error('Executable definitions do not match normalized deployment configuration.');
}

function parseDeploymentDefinition(value: unknown): ProjectionMigrationDeploymentDefinition {
  const keys = ['projectionName', 'generation', 'from', 'joins', 'reverseSubscriptions', 'subscriptions', 'deduplication', 'hookKeys', 'identityConfiguration'];
  if (
    !record(value) ||
    unknownKeys(value, keys).length ||
    typeof value.projectionName !== 'string' ||
    typeof value.generation !== 'string' ||
    !Array.isArray(value.joins) ||
    !Array.isArray(value.reverseSubscriptions) ||
    !Array.isArray(value.subscriptions) ||
    !Array.isArray(value.hookKeys) ||
    !value.hookKeys.every(isString)
  )
    throw new Error('Invalid deployment definition.');
  assertCanonicalConfiguration(value.identityConfiguration);
  return {
    projectionName: value.projectionName,
    generation: value.generation,
    from: parseStream(value.from),
    joins: value.joins.map(parseStream),
    reverseSubscriptions: value.reverseSubscriptions.map(parseStream),
    subscriptions: value.subscriptions.map(parseSubscription),
    deduplication: parseDeduplication(value.deduplication),
    hookKeys: [...value.hookKeys].sort(),
    identityConfiguration: value.identityConfiguration
  };
}
function parseStream(value: unknown): ProjectionMigrationStreamConfiguration {
  if (
    !record(value) ||
    unknownKeys(value, ['aggregateType', 'aggregateKeys', 'aggregatePureKeys', 'aggregateEventProjectorKeys', 'handlerKeys']).length ||
    typeof value.aggregateType !== 'string' ||
    !Array.isArray(value.aggregateKeys) ||
    !value.aggregateKeys.every(isString) ||
    !Array.isArray(value.aggregatePureKeys) ||
    !value.aggregatePureKeys.every(isString) ||
    !Array.isArray(value.aggregateEventProjectorKeys) ||
    !value.aggregateEventProjectorKeys.every(isString) ||
    !Array.isArray(value.handlerKeys) ||
    !value.handlerKeys.every(isString)
  )
    throw new Error('Invalid deployment stream.');
  return {
    aggregateType: value.aggregateType,
    aggregateKeys: [...value.aggregateKeys].sort(),
    aggregatePureKeys: [...value.aggregatePureKeys].sort(),
    aggregateEventProjectorKeys: [...value.aggregateEventProjectorKeys].sort(),
    handlerKeys: [...value.handlerKeys].sort()
  };
}
function parseSubscription(value: unknown): { aggregateType: string; aggregateId: string } {
  if (
    !record(value) ||
    unknownKeys(value, ['aggregateType', 'aggregateId']).length ||
    typeof value.aggregateType !== 'string' ||
    typeof value.aggregateId !== 'string'
  )
    throw new Error('Invalid deployment subscription.');
  return { aggregateType: value.aggregateType, aggregateId: value.aggregateId };
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
    if (value.warnings === undefined) return { strategy: value.strategy };
    if (!record(value.warnings) || unknownKeys(value.warnings, ['warnAtSourceCount', 'warnAtMetadataBytes']).length) throw new Error('Invalid warnings.');
    if (
      (value.warnings.warnAtSourceCount !== undefined && !Number.isSafeInteger(value.warnings.warnAtSourceCount)) ||
      (value.warnings.warnAtMetadataBytes !== undefined && !Number.isSafeInteger(value.warnings.warnAtMetadataBytes))
    )
      throw new Error('Invalid warnings.');
    return {
      strategy: value.strategy,
      warnings: {
        ...(Number.isSafeInteger(value.warnings.warnAtSourceCount) ? { warnAtSourceCount: Number(value.warnings.warnAtSourceCount) } : {}),
        ...(Number.isSafeInteger(value.warnings.warnAtMetadataBytes) ? { warnAtMetadataBytes: Number(value.warnings.warnAtMetadataBytes) } : {})
      }
    };
  }
  throw new Error('Invalid runtime deduplication identity.');
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
function isString(value: unknown): value is string {
  return typeof value === 'string';
}
function isExecutableDefinition(value: unknown): value is ProjectionCommitRegistryDefinition<unknown> {
  return (
    record(value) &&
    typeof value.generation === 'string' &&
    record(value.definition) &&
    typeof value.definition.name === 'string' &&
    record(value.definition.fromStream) &&
    typeof value.definition.initialState === 'function' &&
    typeof value.definition.identity === 'function' &&
    Array.isArray(value.definition.subscriptions) &&
    record(value.definition.deduplication)
  );
}
function assertCanonicalConfiguration(value: unknown): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return;
  if (Array.isArray(value)) {
    for (const entry of value) assertCanonicalConfiguration(entry);
    return;
  }
  if (!record(value)) throw new Error('Identity configuration must be canonical data.');
  for (const entry of Object.values(value)) assertCanonicalConfiguration(entry);
}
