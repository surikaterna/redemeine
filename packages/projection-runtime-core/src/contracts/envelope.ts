import type { ProjectionEvent } from '../types';

export type ProjectionIngressPriority = 'low' | 'normal' | 'high';

export interface ProjectionResumeToken {
  token?: string;
  partition?: string;
  offset?: string;
}

export interface ProjectionEnvelopeMetadata {
  messageId: string;
  priority: ProjectionIngressPriority;
  retryCount: number;
  resume?: ProjectionResumeToken;
}

export interface ProjectionIngressEnvelope {
  event: ProjectionEvent;
  metadata: ProjectionEnvelopeMetadata;
}
