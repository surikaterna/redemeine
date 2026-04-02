import {
  buildCanonicalSagaInstanceUrn,
  buildCanonicalSagaUrn
} from './canonical';
import { normalizeSagaIdentity } from './normalizeSagaIdentity';
import type { SagaIdentityInput } from './types';

export type SagaStructuredIdentity = SagaIdentityInput;

function assertNonEmptyString(value: string, fieldName: 'namespace' | 'name' | 'instanceId'): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`Saga ${fieldName} must be a non-empty string`);
  }
}

/**
 * Derive canonical saga type URN from a normalized structured identity.
 *
 * Format: `urn:redemeine:saga:<namespace>:<name>:v<version>`
 */
export function deriveSagaUrn(identity: SagaStructuredIdentity): string {
  const normalized = normalizeSagaIdentity(identity);
  return buildCanonicalSagaUrn(normalized);
}

/**
 * Derive canonical saga instance URN from identity and explicit instance id.
 *
 * Format: `urn:redemeine:saga:<namespace>:<name>:v<version>:instance:<instanceId>`
 */
export function deriveSagaInstanceUrn(identity: SagaStructuredIdentity, instanceId: string): string {
  assertNonEmptyString(instanceId, 'instanceId');

  const normalized = normalizeSagaIdentity(identity);
  return buildCanonicalSagaInstanceUrn(normalized, instanceId);
}

export function parseSagaUrn(urn: string): SagaStructuredIdentity {
  const match = /^urn:redemeine:saga:([^:]+):([^:]+):v([1-9][0-9]*)$/.exec(urn);
  if (!match) {
    throw new TypeError('Saga URN must match "urn:redemeine:saga:<namespace>:<name>:v<version>".');
  }

  return normalizeSagaIdentity({
    namespace: match[1],
    name: match[2],
    version: Number(match[3])
  });
}
