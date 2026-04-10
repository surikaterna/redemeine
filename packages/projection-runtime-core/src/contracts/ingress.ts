import type { ProjectionIngressEnvelope } from './envelope';

export type ProjectionIngressAckBarrierStage = 'received' | 'published_durable' | 'ackable';

export interface ProjectionIngressReceivedLifecycleStep {
  stage: 'received';
}

export interface ProjectionIngressPublishedDurableLifecycleStep {
  stage: 'published_durable';
}

export interface ProjectionIngressAckableLifecycleStep {
  stage: 'ackable';
}

export interface ProjectionIngressNackLifecycleStep {
  stage: 'nack';
  cause: ProjectionIngressNackCause;
}

export type ProjectionIngressAckLifecycle = readonly [
  ProjectionIngressReceivedLifecycleStep,
  ProjectionIngressPublishedDurableLifecycleStep,
  ProjectionIngressAckableLifecycleStep
];

export type ProjectionIngressNackLifecycle =
  | readonly [ProjectionIngressReceivedLifecycleStep, ProjectionIngressNackLifecycleStep]
  | readonly [
      ProjectionIngressReceivedLifecycleStep,
      ProjectionIngressPublishedDurableLifecycleStep,
      ProjectionIngressNackLifecycleStep
    ];

export type ProjectionIngressNackCause = 'timeout' | 'failure';

export interface ProjectionIngressAckDecision {
  status: 'ack';
  lifecycle: ProjectionIngressAckLifecycle;
}

export interface ProjectionIngressNackDecision {
  status: 'nack';
  retryable: boolean;
  reason: string;
  cause: ProjectionIngressNackCause;
  lifecycle: ProjectionIngressNackLifecycle;
}

export type ProjectionIngressDecision = ProjectionIngressAckDecision | ProjectionIngressNackDecision;

export interface ProjectionIngressResultItem {
  messageId: string;
  decision: ProjectionIngressDecision;
}

export interface ProjectionIngressPushResult {
  item: ProjectionIngressResultItem;
}

export interface ProjectionIngressPushManyResult {
  items: ProjectionIngressResultItem[];
}

export interface ProjectionIngress {
  push(envelope: ProjectionIngressEnvelope): Promise<ProjectionIngressPushResult>;
  pushMany(envelopes: readonly ProjectionIngressEnvelope[]): Promise<ProjectionIngressPushManyResult>;
}
