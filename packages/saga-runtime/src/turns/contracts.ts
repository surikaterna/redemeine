import type { Event } from '@redemeine/kernel';
import type { SagaCanonicalCorrelation } from '../identity/canonicalCorrelation';
import type { CompiledSagaRoute, CompiledSagaRoutingTable, SagaRouteSourceEvent } from '../routing/contracts';

export interface SagaTurnSourceEvent extends SagaRouteSourceEvent {
  readonly createDateTime: string;
  readonly aggregateType?: string;
  readonly aggregateId?: string;
  readonly sequence?: number;
  readonly correlationId?: string;
  readonly causationId?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface SagaTurnIdentity {
  readonly sourceTriggerId: string;
  readonly sagaKey: string;
  readonly instanceId: string;
  readonly routeId: string;
}

export interface SagaTurnStoredCommit {
  readonly streamId: string;
  readonly commitId: string;
  readonly commitSequence: number;
  readonly identity: SagaTurnIdentity;
}

export interface SagaTurnStreamSnapshot {
  readonly streamId: string;
  readonly nextCommitSequence: number;
  readonly events: readonly unknown[];
}

export interface SagaTurnAppendRequest {
  readonly streamId: string;
  readonly commitId: string;
  readonly expectedNextCommitSequence: number;
  readonly identity: SagaTurnIdentity;
  readonly events: readonly Event[];
}

export type SagaTurnAppendResult =
  | { readonly status: 'committed'; readonly commitSequence: number }
  | { readonly status: 'reconciled'; readonly commit: SagaTurnStoredCommit }
  | { readonly status: 'conflict' };

export interface SagaTurnRepository {
  load(instanceId: string): Promise<SagaTurnStreamSnapshot>;
  findCommit(streamId: string, commitId: string): Promise<SagaTurnStoredCommit | null>;
  append(request: SagaTurnAppendRequest): Promise<SagaTurnAppendResult>;
}

export type SagaTurnRouteStatus = 'committed' | 'reconciled' | 'unmatched' | 'no_op';

export interface SagaTurnRouteOutcome {
  readonly status: SagaTurnRouteStatus;
  readonly sagaKey: string;
  readonly sourceTriggerId: string;
  readonly instanceId: string;
  readonly routeId?: string;
  readonly commitId?: string;
  readonly reason?: 'absent_on_route' | 'existing_start_only';
}

export interface SagaTurnProcessorOptions {
  readonly maxConflictRetries?: number;
}

export interface SagaTurnRouteGroup {
  readonly sagaKey: string;
  readonly routes: readonly CompiledSagaRoute[];
}

export interface SagaTurnPlan {
  readonly table: CompiledSagaRoutingTable;
  readonly source: SagaTurnSourceEvent;
  readonly groups: readonly SagaTurnRouteGroup[];
}

export interface ResolvedSagaTurnRouteGroup {
  readonly sagaKey: string;
  readonly sourceTriggerId: string;
  readonly instanceId: string;
  readonly correlation: SagaCanonicalCorrelation;
  readonly startRoute: Extract<CompiledSagaRoute, { kind: 'start' }> | null;
  readonly onRoute: Extract<CompiledSagaRoute, { kind: 'on' }> | null;
}
