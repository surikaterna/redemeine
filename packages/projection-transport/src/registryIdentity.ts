import type { ProjectionDeduplicationStrategy, ProjectionQueueRegistryManifest,
  ProjectionRegistryDefinitionManifest } from '@redemeine/projection-runtime-core';
import type { ProjectionCommitRegistryDefinition } from '@redemeine/projection-worker-core';
import { projectionRegistryDigest } from './registryDigest';

export interface ProjectionStreamConfiguration {
  readonly aggregateType: string;
  readonly aggregateKeys: readonly string[];
  readonly aggregatePureKeys: readonly string[];
  readonly aggregateEventProjectorKeys: readonly string[];
  readonly handlerKeys: readonly string[];
}

export interface ProjectionDeploymentDefinition {
  readonly projectionName: string;
  readonly generation: string;
  readonly from: ProjectionStreamConfiguration;
  readonly joins: readonly ProjectionStreamConfiguration[];
  readonly reverseSubscriptions: readonly ProjectionStreamConfiguration[];
  readonly subscriptions: readonly { aggregateType: string; aggregateId: string }[];
  readonly deduplication: ProjectionDeduplicationStrategy;
  readonly hookKeys: readonly string[];
  readonly identityConfiguration: unknown;
}

export function projectionDefinitionRegistryDigest(definitions: readonly ProjectionRegistryDefinitionManifest[]): `sha256:${string}` {
  return projectionRegistryDigest(definitions, 'redemeine:projection:definition-registry:v1');
}

export function projectionQueueRegistryDigest(manifest: Omit<ProjectionQueueRegistryManifest, 'manifestId'>): `sha256:${string}` {
  return projectionRegistryDigest(manifest, 'redemeine:projection:queue-registry:v1');
}

// These historical domain tags are immutable parts of already-bound queue manifest identities.
export function projectionDefinitionHash(configuration: ProjectionDeploymentDefinition,
  artifactDigest: `sha256:${string}`): `sha256:${string}` {
  return projectionRegistryDigest({ configuration, artifactDigest }, 'redemeine:migration:definition:v2');
}

export function projectionRuntimeConfigurationDigest(configurations: readonly ProjectionDeploymentDefinition[]): `sha256:${string}` {
  return projectionRegistryDigest(configurations, 'redemeine:migration:runtime-configuration:v2');
}

function normalizeStream(value: { aggregate: { aggregateType: string }; handlers: Record<string, unknown> }): ProjectionStreamConfiguration {
  const aggregate = value.aggregate as { aggregateType: string; pure?: unknown };
  const pure = typeof aggregate.pure === 'object' && aggregate.pure !== null ? aggregate.pure as Record<string, unknown> : {};
  const projectors = typeof pure.eventProjectors === 'object' && pure.eventProjectors !== null
    ? pure.eventProjectors as Record<string, unknown> : {};
  return { aggregateType: aggregate.aggregateType, aggregateKeys: Object.keys(aggregate).sort(),
    aggregatePureKeys: Object.keys(pure).sort(), aggregateEventProjectorKeys: Object.keys(projectors).sort(),
    handlerKeys: Object.keys(value.handlers).sort() };
}

export function normalizeProjectionRegistryDefinitions<TState>(values: readonly ProjectionCommitRegistryDefinition<TState>[],
  identityConfigurations: readonly unknown[]): readonly ProjectionDeploymentDefinition[] {
  if (values.length !== identityConfigurations.length) throw new Error('Identity configuration coverage mismatch.');
  return values.map(({ generation, definition }, index) => ({
    projectionName: definition.name, generation, from: normalizeStream(definition.fromStream),
    joins: (definition.joinStreams ?? []).map(normalizeStream),
    reverseSubscriptions: (definition.reverseSubscribeStreams ?? []).map(normalizeStream),
    subscriptions: definition.subscriptions.map((entry) => ({ aggregateType: entry.aggregate.aggregateType, aggregateId: entry.aggregateId })),
    deduplication: definition.deduplication, hookKeys: Object.keys(definition.hooks ?? {}).sort(),
    identityConfiguration: identityConfigurations[index]
  }));
}
