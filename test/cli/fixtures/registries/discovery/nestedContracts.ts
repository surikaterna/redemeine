import { account, publicView, runtimeView } from './mixed';
import type { AggregateDefinition as RuntimeAggregate, JoinStreamDefinition as RuntimeJoin } from '../../../../../packages/projection-runtime-core/src/createProjection';
import type { ProjectionAggregateSource, ProjectionStreamDefinition as PublicStream } from '../../../../../packages/projection/src/projectionTypes';

export const badCreators = { ...account, eventCreators: { wrong: () => 123 }, aggregateType: 'bad-creators' as const };
export const badCreatorPayload = { ...account, eventCreators: { added: () => ({ type: 'added', payload: 'wrong' }) },
  aggregateType: 'bad-creator-payload' as const };
export const badCommandCreators = { ...account, commandCreators: { wrong: () => 123 }, aggregateType: 'bad-command-creators' as const };
export const badMissingCreators = { ...account, eventCreators: {}, aggregateType: 'bad-missing-creators' as const };
export const badUnresolvedCreator = { ...account, eventCreators: { added: () => ({ type: 'added', payload: undefined as unknown }) },
  aggregateType: 'bad-unresolved-creator' as const };
export const badStream = { ...publicView, fromStream: { aggregate: { aggregateType: 'fake' }, handlers: {} } };
export const badSubscriptions = { ...publicView, subscriptions: [{ aggregate: { aggregateType: 'fake' }, aggregateId: 'id' }] };
export const badRuntimeStream = { ...runtimeView, fromStream: { aggregate: { aggregateType: 'fake' }, handlers: {} } };
export const badRuntimeSubscriptions = { ...runtimeView, subscriptions: [{ aggregate: { aggregateType: 'fake' }, aggregateId: 'id' }] };
export const badNestedBuiltStream = { ...publicView, fromStream: { aggregate: badCreators, handlers: {} } };
export const badNestedBuiltSubscriptions = { ...publicView, subscriptions: [{ aggregate: badCreatorPayload, aggregateId: 'id' }] };

const minimal: Pick<RuntimeAggregate<number, {}>, 'aggregateType'> = { aggregateType: 'fake' };
const noPure: Omit<RuntimeAggregate<number, {}>, 'pure'> = { aggregateType: 'fake', initialState: 0 };
const noState: Omit<RuntimeAggregate<number, {}>, 'initialState'> = { aggregateType: 'fake', pure: { eventProjectors: {} } };
const noProjectors: Omit<RuntimeAggregate<number, {}>, 'pure'> & { pure: {} } = { aggregateType: 'fake', initialState: 0, pure: {} };
export const badRuntimePick = { ...runtimeView, fromStream: { aggregate: minimal, handlers: {} } };
export const badRuntimeOmitPure = { ...runtimeView, fromStream: { aggregate: noPure, handlers: {} } };
export const badRuntimeOmitState = { ...runtimeView, fromStream: { aggregate: noState, handlers: {} } };
export const badRuntimeMissingProjectors = { ...runtimeView, fromStream: { aggregate: noProjectors, handlers: {} } };

const narrowJoin: RuntimeJoin<number>['aggregate'] = { aggregateType: 'join' };
const narrowPublic: PublicStream<number>['aggregate'] = { aggregateType: 'public' };
const noSourceProjectors: Pick<ProjectionAggregateSource, 'aggregateType'> = { aggregateType: 'source' };
export const badRuntimeJoinAsPrimary = { ...runtimeView, fromStream: { aggregate: narrowJoin, handlers: {} } };
export const badRuntimePublicAsPrimary = { ...runtimeView, fromStream: { aggregate: narrowPublic, handlers: {} } };
export const badPublicPickSource = { ...publicView, fromStream: { aggregate: noSourceProjectors, handlers: {} } };
