/**
 * Canonical structured identity fields for a saga definition.
 *
 * Source of truth: `namespace`, `name`, and integer `version`.
 * String derivatives (`sagaType`, `sagaUrn`) must be generated from these fields.
 */
export interface SagaIdentityFields {
  readonly namespace: string;
  readonly name: string;
  readonly version: number;
}

/**
 * Deterministic identity strings derived from canonical structured fields.
 */
export interface SagaIdentityDerived {
  readonly sagaType: string;
  readonly sagaUrn: string;
  readonly instanceUrn?: string;
}

/**
 * Full canonical saga identity contract.
 */
export type SagaIdentityContract = SagaIdentityFields & SagaIdentityDerived;
