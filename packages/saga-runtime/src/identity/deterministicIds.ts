import { createHash } from 'node:crypto';
import type { SagaCanonicalCorrelation } from '../sagaAggregateContracts';
import { serializeSagaCorrelation } from './correlation';

export interface SourceTriggerIdentityInput {
  readonly partitionId: string;
  readonly streamId: string;
  readonly commitId: string;
  readonly eventIndex: number;
}

export interface TurnCommitIdentityInput {
  readonly sourceTriggerId: string;
  readonly sagaKey: string;
  readonly instanceId: string;
  readonly routeId: string;
}

const IDENTITY_PART_MAX_BYTES = 4096;

function assertIdentityPart(name: string, value: string): void {
  const bytes = new TextEncoder().encode(value).byteLength;
  if (bytes === 0 || bytes > IDENTITY_PART_MAX_BYTES) {
    throw new RangeError(`${name} must contain 1-${IDENTITY_PART_MAX_BYTES} UTF-8 bytes`);
  }
}

function deriveId(prefix: string, domain: string, parts: readonly string[]): string {
  for (let index = 0; index < parts.length; index += 1) {
    assertIdentityPart(`identity part ${index}`, parts[index]!);
  }
  const digest = createHash('sha256')
    .update(JSON.stringify([domain, ...parts]), 'utf8')
    .digest('base64url');
  return `${prefix}_${digest}`;
}

/** SHA-256/base64url identity over the saga family key and type-tagged correlation; definition version is intentionally excluded. */
export function deriveSagaInstanceId(sagaKey: string, correlation: SagaCanonicalCorrelation): string {
  return deriveId('saga_i', 'redemeine.saga.instance.v1', [sagaKey, serializeSagaCorrelation(correlation)]);
}

/** SHA-256/base64url identity over source position; eventId is retained by routing but intentionally excluded. */
export function deriveSourceTriggerId(input: SourceTriggerIdentityInput): string {
  if (!Number.isSafeInteger(input.eventIndex) || input.eventIndex < 0) {
    throw new RangeError('eventIndex must be a zero-based safe integer');
  }
  return deriveId('saga_t', 'redemeine.saga.source-trigger.v1', [input.partitionId, input.streamId, input.commitId, input.eventIndex.toString(10)]);
}

/** SHA-256/base64url identity that includes route identity so one source event can safely fan out. */
export function deriveTurnCommitId(input: TurnCommitIdentityInput): string {
  return deriveId('saga_c', 'redemeine.saga.turn-commit.v1', [input.sourceTriggerId, input.sagaKey, input.instanceId, input.routeId]);
}
