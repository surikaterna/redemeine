import type { ProjectionSourceCommit } from './sourceCommit';

interface LiveStartIdentity {
  readonly epoch: string;
  readonly queueName: 'rdm.projection.commits';
  readonly vhost: string;
  readonly bindingRef: string;
  readonly registryDigest: string;
  readonly generation: string;
  readonly sourceScopeDigest: string;
  readonly provisioningRef: string;
}

export interface LiveNativeStartRecord extends LiveStartIdentity {
  readonly mode: 'LIVE_FROM_BOUNDARY';
  readonly nativeStartRef: string;
  readonly publisherRef: string;
  readonly orderedFeedQualificationRef: string;
}

export interface LiveBrokerStartRecord extends LiveStartIdentity {
  readonly mode: 'LIVE_FROM_QUEUE_BINDING';
  readonly queueNonce: string;
  readonly publisherContract: {
    readonly ordering: 'external_single_ordered_publisher';
    readonly recoveryPolicy: 'external_best_effort_on_expiry';
    readonly historicalCompleteness: 'unknown';
  };
}

export type LiveStartRecord = LiveNativeStartRecord | LiveBrokerStartRecord;
export type LiveConsumerSelection = { readonly exclusive: true; readonly consumerMode?: 'exclusive' }
  | { readonly exclusive: false; readonly consumerMode: 'single_active' };

export interface LiveSourcePosition {
  readonly epoch: string;
  readonly registryDigest: string;
  readonly sourceId: string;
  readonly firstSequence: number;
  readonly firstCommitId: string;
  /** Ordering only. Null is not an applied or accepted prefix. */
  readonly coveredThrough: number | null;
}

export interface LiveDeliveryIdentity {
  readonly sessionRef: string;
  readonly deliveryTag: number;
  readonly messageId: string;
  readonly redelivered: boolean;
}

interface FirstLiveEvidenceIdentity {
  readonly position: LiveSourcePosition;
  readonly delivery: LiveDeliveryIdentity;
  /** Must reject after cancellation, requeue, disconnect or reservation release. */
  assertCurrent(): void;
}

export type FirstLiveEvidence = FirstLiveEvidenceIdentity & (
  { readonly kind: 'ordered_first_live_delivery'; readonly start: LiveNativeStartRecord }
  | { readonly kind: 'broker_first_retained_delivery'; readonly start: LiveBrokerStartRecord }
);

export type LiveEvidenceResult<T> =
  | { readonly status: 'qualified'; readonly value: T }
  | { readonly status: 'unproven'; readonly reason: string };

export interface LiveFeedSession {
  readonly sessionRef: string;
  readonly start: LiveStartRecord;
  assertCurrent(): void;
  reserve(delivery: LiveDeliveryIdentity): void;
  certifyFirst(commit: ProjectionSourceCommit, delivery: LiveDeliveryIdentity): Promise<LiveEvidenceResult<FirstLiveEvidence>>;
  settled(delivery: LiveDeliveryIdentity): void;
  invalidate(): void;
  /** Broker mode only: consume-ok precedes active-consumer proof; no delivery is released before this joins. */
  activateConsumer?(consumerTag: string): Promise<void>;
}

export type LiveFeedOpenResult = LiveEvidenceResult<LiveFeedSession>
  | { readonly status: 'staged'; readonly value: LiveFeedSession & { activateConsumer(consumerTag: string): Promise<void> } };

/** Native mode qualifies native history; broker mode qualifies owned topology/session under the explicit publisher contract. */
export interface LiveFeedEvidencePort {
  openSession(start: LiveStartRecord, channel: {
    readonly sessionRef: string;
    readonly queueName: string;
    readonly prefetch: 1;
  } & LiveConsumerSelection): Promise<LiveFeedOpenResult>;
}

export interface LiveSourceOrderPort {
  load(sourceId: string, epoch: string): Promise<LiveSourcePosition | null>;
  admitFirst(evidence: FirstLiveEvidence): Promise<LiveSourcePosition>;
  advanceCoverage(expected: LiveSourcePosition, sequence: number): Promise<LiveSourcePosition>;
}

export interface LiveWorkBudget {
  readonly maxCommits: number;
  readonly maxBytes: number;
  readonly maxMilliseconds: number;
  readonly maxEventsPerCommit: number;
}

export interface LiveCommitResult {
  readonly status: 'completed' | 'continuation' | 'paused';
  readonly processedCommits: number;
  readonly coveredThrough: number | null;
  /** Fixed-size reason code, never accumulated handler errors or payloads. */
  readonly reason?: string;
}

export interface LiveCommitCoordinator {
  readonly epoch: string;
  readonly registryDigest: string;
  readonly generation: string;
  process(commit: ProjectionSourceCommit, position: LiveSourcePosition, assertCurrent: () => void): Promise<LiveCommitResult>;
}

export function sameLiveFloor(left: LiveSourcePosition, right: LiveSourcePosition): boolean {
  return left.epoch === right.epoch && left.registryDigest === right.registryDigest
    && left.sourceId === right.sourceId && left.firstSequence === right.firstSequence
    && left.firstCommitId === right.firstCommitId;
}
