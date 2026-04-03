import type { SagaStartPolicy } from './startPolicy';

export type SagaTriggerMisfirePolicy =
  | SagaTriggerMisfirePolicyCatchUpAll
  | SagaTriggerMisfirePolicyCatchUpBounded
  | SagaTriggerMisfirePolicyLatestOnly
  | SagaTriggerMisfirePolicySkipUntilNext;

export interface SagaTriggerMisfirePolicyCatchUpAll {
  readonly mode: 'catch_up_all';
}

export interface SagaTriggerMisfirePolicyCatchUpBounded {
  readonly mode: 'catch_up_bounded';
  readonly maxCatchUpCount: number;
}

export interface SagaTriggerMisfirePolicyLatestOnly {
  readonly mode: 'latest_only';
}

export interface SagaTriggerMisfirePolicySkipUntilNext {
  readonly mode: 'skip_until_next';
}

export interface SagaTriggerRestartPolicy {
  readonly mode?: 'graceful' | 'force';
  readonly reason?: string;
}

export interface SagaSchedulerTriggerPolicyContract {
  readonly restart?: SagaTriggerRestartPolicy;
  readonly misfire?: SagaTriggerMisfirePolicy;
}

/**
 * Shared trigger contract for saga-start definitions.
 *
 * This is intentionally definition-oriented and can be consumed by future
 * trigger builders without changing runtime behavior in this bead.
 */
export interface SagaTriggerStartContract {
  readonly startPolicy?: SagaStartPolicy;
  readonly schedulerPolicy?: SagaSchedulerTriggerPolicyContract;
}
