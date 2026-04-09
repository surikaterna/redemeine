import type { ProjectionIngressEnvelope } from './envelope';

export interface ProjectionIngressAckDecision {
  status: 'ack';
}

export interface ProjectionIngressNackDecision {
  status: 'nack';
  retryable: boolean;
  reason: string;
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
