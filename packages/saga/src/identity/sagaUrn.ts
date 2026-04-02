import {
  buildCanonicalSagaInstanceUrn,
  buildCanonicalSagaUrn
} from './canonical';

export interface SagaStructuredIdentity {
  readonly namespace: string;
  readonly name: string;
  readonly version: number;
}

function assertNonEmptyString(value: string, fieldName: 'namespace' | 'name' | 'instanceId'): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`Saga ${fieldName} must be a non-empty string`);
  }
}

function assertVersion(version: number): void {
  if (!Number.isInteger(version) || version < 1) {
    throw new TypeError('Saga version must be a positive integer');
  }
}

/**
 * Derive canonical saga type URN from a normalized structured identity.
 *
 * Format: `urn:redemeine:saga:<namespace>:<name>:v<version>`
 */
export function deriveSagaUrn(identity: SagaStructuredIdentity): string {
  const { namespace, name, version } = identity;

  assertNonEmptyString(namespace, 'namespace');
  assertNonEmptyString(name, 'name');
  assertVersion(version);

  return buildCanonicalSagaUrn(identity);
}

/**
 * Derive canonical saga instance URN from identity and explicit instance id.
 *
 * Format: `urn:redemeine:saga:<namespace>:<name>:v<version>:instance:<instanceId>`
 */
export function deriveSagaInstanceUrn(identity: SagaStructuredIdentity, instanceId: string): string {
  assertNonEmptyString(instanceId, 'instanceId');

  const { namespace, name, version } = identity;

  assertNonEmptyString(namespace, 'namespace');
  assertNonEmptyString(name, 'name');
  assertVersion(version);

  return buildCanonicalSagaInstanceUrn(identity, instanceId);
}
