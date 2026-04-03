declare const require: (id: string) => any;

const sagaPackage = require('@redemeine/saga');

export const createSagaDispatchContext = sagaPackage.createSagaDispatchContext as any;
export const runSagaHandler = sagaPackage.runSagaHandler as any;
export * from './createSagaAggregate';
export * from './inboundRouter';
export * from './referenceAdapters';
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
