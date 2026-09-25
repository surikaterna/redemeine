import { createHash } from 'node:crypto';
import { type SagaCanonicalCorrelation, serializeSagaCorrelation } from './canonicalCorrelation';
import { encodeCanonicalIdentityPreimage } from './canonicalEncoding';

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

export type SagaRouteIdentityInput =
  | {
      readonly kind: 'start';
      readonly sagaKey: string;
      readonly definitionVersion: number;
      readonly triggerIndex: number;
      readonly eventType: string;
    }
  | {
      readonly kind: 'on';
      readonly sagaKey: string;
      readonly definitionVersion: number;
      readonly aggregateType: string;
      readonly handlerKey: string;
      readonly eventType: string;
    };

const IDENTITY_PART_MAX_BYTES = 4096;

function assertIdentityPart(name: string, value: string): void {
  const bytes = new TextEncoder().encode(value).byteLength;
  if (bytes === 0 || bytes > IDENTITY_PART_MAX_BYTES) {
    throw new RangeError(`${name} must contain 1-${IDENTITY_PART_MAX_BYTES} UTF-8 bytes`);
  }
}

function validateIdentityParts(parts: readonly string[]): void {
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part === undefined) throw new RangeError(`identity part ${index} is missing`);
    assertIdentityPart(`identity part ${index}`, part);
  }
}

function deriveFramedId(prefix: string, domain: string, parts: readonly string[]): string {
  validateIdentityParts(parts);
  const digest = createHash('sha256').update(encodeCanonicalIdentityPreimage(domain, parts)).digest('base64url');
  return `${prefix}_${digest}`;
}

function deriveStableSourceId(parts: readonly string[]): string {
  validateIdentityParts(parts);
  const digest = createHash('sha256')
    .update(JSON.stringify(['redemeine.saga.source-trigger.v1', ...parts]), 'utf8')
    .digest('base64url');
  return `saga_t_${digest}`;
}

/** SHA-256/base64url identity over the saga family key and type-tagged correlation; definition version is intentionally excluded. */
export function deriveSagaInstanceId(sagaKey: string, correlation: SagaCanonicalCorrelation): string {
  return deriveFramedId('saga_i', 'redemeine.saga.instance.v2', [sagaKey, serializeSagaCorrelation(correlation)]);
}

/** SHA-256/base64url identity over source position; eventId is retained by routing but intentionally excluded. */
export function deriveSourceTriggerId(input: SourceTriggerIdentityInput): string {
  if (!Number.isSafeInteger(input.eventIndex) || input.eventIndex < 0) {
    throw new RangeError('eventIndex must be a zero-based safe integer');
  }
  return deriveStableSourceId([input.partitionId, input.streamId, input.commitId, input.eventIndex.toString(10)]);
}

export function deriveSagaRouteId(input: SagaRouteIdentityInput): string {
  if (!Number.isSafeInteger(input.definitionVersion) || input.definitionVersion <= 0) {
    throw new RangeError('definitionVersion must be a positive safe integer');
  }
  const common = [input.kind, input.sagaKey, input.definitionVersion.toString(10), input.eventType];
  if (input.kind === 'start') {
    if (!Number.isSafeInteger(input.triggerIndex) || input.triggerIndex < 0) throw new RangeError('triggerIndex must be a zero-based safe integer');
    return deriveFramedId('saga_r', 'redemeine.saga.route.v1', [...common, input.triggerIndex.toString(10)]);
  }
  return deriveFramedId('saga_r', 'redemeine.saga.route.v1', [...common, input.aggregateType, input.handlerKey]);
}

/** SHA-256/base64url identity that includes route identity so one source event can safely fan out. */
export function deriveTurnCommitId(input: TurnCommitIdentityInput): string {
  return deriveFramedId('saga_c', 'redemeine.saga.turn-commit.v2', [input.sourceTriggerId, input.sagaKey, input.instanceId, input.routeId]);
}

/** Local command/event identity for a pure turn; never used to rewrite incoming source envelopes. */
export function deriveSagaTurnEnvelopeId(input: TurnCommitIdentityInput, sourceTime: string, ordinal: number, kind: 'command' | 'event'): string {
  if (!Number.isSafeInteger(ordinal) || ordinal < 0) throw new RangeError('Turn ordinal must be a non-negative safe integer');
  return deriveFramedId('saga_e', 'redemeine.saga.turn-envelope.v1', [
    input.sourceTriggerId, input.sagaKey, input.instanceId, input.routeId, sourceTime, ordinal.toString(), kind
  ]);
}
