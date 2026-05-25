declare const require: (id: string) => any;

// SAFETY: require() used to break circular dependency between saga-runtime and saga packages
const sagaPackage = require('@redemeine/saga');

// SAFETY: as any required because require() returns untyped module - types are re-exported from @redemeine/saga
export const createSagaDispatchContext = sagaPackage.createSagaDispatchContext as any;
export const runSagaHandler = sagaPackage.runSagaHandler as any;
export * from './createSagaAggregate';
export * from './sagaExecutionBridge';
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
