import { createAggregate } from '../../../../../packages/aggregate/src';
import { createProjection } from '../../../../../packages/projection/src';
import { createProjection as runtimeProjection } from '../../../../../packages/projection-runtime-core/src';
import type { ProjectionAggregateSource, ProjectionDefinition as PublicDefinition, ProjectionStreamDefinition as PublicStream } from '../../../../../packages/projection/src/projectionTypes';
import type { JoinStreamDefinition as RuntimeJoin, ProjectionDefinition as RuntimeDefinition } from '../../../../../packages/projection-runtime-core/src/createProjection';

export const declaredAggregate = createAggregate('declarations', { enabled: true }).build();
export const declaredPublic = createProjection('declared-public', () => 1).from(declaredAggregate, {}).build();
export const declaredRuntime = runtimeProjection('declared-runtime', () => 'value').from(declaredAggregate, {}).build();
export const declaredPublicCommit = createProjection('declared-public-commit', () => 1).from(declaredAggregate, {})
  .deduplication({ strategy: 'own_record' }).buildCommitDefinition();
export const declaredRuntimeCommit = runtimeProjection('declared-runtime-commit', () => 'value').from(declaredAggregate, {})
  .deduplication({ strategy: 'own_record' }).buildCommitDefinition();

const publicSource: ProjectionAggregateSource = { aggregateType: 'source', pure: { eventProjectors: {} } };
const publicNarrow: PublicStream<number>['aggregate'] = { aggregateType: 'public-narrow' };
const publicSubscription: PublicDefinition<number>['subscriptions'][number]['aggregate'] = { aggregateType: 'public-subscription' };
const runtimeNarrow: RuntimeJoin<string>['aggregate'] = { aggregateType: 'runtime-narrow' };
const runtimeSubscription: RuntimeDefinition<string>['subscriptions'][number]['aggregate'] = { aggregateType: 'runtime-subscription' };
export const declaredPublicSource = { ...declaredPublic, name: 'public-source' as const,
  fromStream: { aggregate: publicSource, handlers: {} } };
export const declaredPublicNarrow = { ...declaredPublic, name: 'public-narrow' as const,
  fromStream: { aggregate: publicNarrow, handlers: {} }, subscriptions: [{ aggregate: publicSubscription, aggregateId: 'id' }] };
export const declaredRuntimeNarrowRoutes = { ...declaredRuntime, name: 'runtime-narrow-routes' as const,
  joinStreams: [{ aggregate: runtimeNarrow, handlers: {} }], reverseSubscribeStreams: [{ aggregate: runtimeNarrow, handlers: {} }],
  subscriptions: [{ aggregate: runtimeSubscription, aggregateId: 'id' }] };
