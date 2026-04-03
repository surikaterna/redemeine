declare const require: (id: string) => any;

const sagaPackage = require('@redemeine/saga');

export const createSagaDispatchContext = sagaPackage.createSagaDispatchContext as any;
export const runSagaHandler = sagaPackage.runSagaHandler as any;
export * from './createSagaAggregate';
export * from './inboundRouter';
export * from './referenceAdapters';
export * from './schedulerPolicyEvaluator';
export {
  createRuntimeAuditLifecycleReadModel,
  type IntentExecutionLifecycleHistoryEntry,
  type LifecycleHistoryQuery,
  type LifecycleHistoryQueryResult,
  type RuntimeAuditLifecycleReadModel,
  type SagaLifecycleHistoryEntry
} from './runtimeAuditProjections';
export type {
  RuntimeAuditActor,
  RuntimeAuditCategory,
  RuntimeAuditCursor,
  RuntimeAuditQuery,
  RuntimeAuditQueryResult,
  RuntimeAuditReaderContract,
  RuntimeAuditRecord,
  RuntimeAuditReference,
  RuntimeAuditWriterContract,
  RuntimeIntentExecutionQuery,
  RuntimeIntentExecutionQueryResult,
  RuntimeIntentExecutionReadModel,
  RuntimeObservabilityReadApiContract,
  RuntimeReadModelContract,
  RuntimeReadModelWindowRequest,
  RuntimeSagaReadModel,
  RuntimeTelemetryContext,
  RuntimeTelemetryKind,
  RuntimeTelemetryLevel,
  RuntimeTelemetryPublisherContract,
  RuntimeTelemetryRecord
} from './runtimeObservabilityContracts';
export type {
  SagaSchedulerTriggerPolicyContract,
  SagaTriggerMisfirePolicy,
  SagaTriggerMisfirePolicyCatchUpAll,
  SagaTriggerMisfirePolicyCatchUpBounded,
  SagaTriggerMisfirePolicyLatestOnly,
  SagaTriggerMisfirePolicySkipUntilNext,
  SagaTriggerRestartPolicy,
  SagaTriggerStartContract
} from '@redemeine/saga';
