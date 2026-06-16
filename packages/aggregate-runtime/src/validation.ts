/**
 * Envelope validation helpers.
 * Pure functions — no side effects, no adapter dependencies.
 */

import type { SyncEnvelope } from './envelopes';
import type { SyncErrorCode } from './errors';

// ---------------------------------------------------------------------------
// Validation result
// ---------------------------------------------------------------------------

export type ValidationResult =
  | { readonly valid: true }
  | { readonly valid: false; readonly code: SyncErrorCode; readonly reason: string };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function hasProperty(obj: unknown, key: string): boolean {
  return obj !== null && typeof obj === 'object' && key in (obj as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// Validators per envelope type
// ---------------------------------------------------------------------------

function validateCommandFields(envelope: SyncEnvelope): ValidationResult {
  if (envelope.type !== 'command_only' && envelope.type !== 'command_with_events') {
    return { valid: true };
  }

  if (!isNonEmptyString(envelope.commandId)) {
    return {
      valid: false,
      code: 'MALFORMED_ENVELOPE',
      reason: 'Missing or empty commandId',
    };
  }

  if (!isNonEmptyString(envelope.commandType)) {
    return {
      valid: false,
      code: 'MALFORMED_ENVELOPE',
      reason: 'Missing or empty commandType',
    };
  }

  return { valid: true };
}

function validateCommonFields(envelope: unknown): ValidationResult {
  if (envelope === null || typeof envelope !== 'object') {
    return {
      valid: false,
      code: 'MALFORMED_ENVELOPE',
      reason: 'Envelope is not an object',
    };
  }

  if (!hasProperty(envelope, 'type') || !isNonEmptyString((envelope as Record<string, unknown>).type)) {
    return {
      valid: false,
      code: 'MALFORMED_ENVELOPE',
      reason: 'Missing or empty envelope type',
    };
  }

  const env = envelope as SyncEnvelope;

  if (!isNonEmptyString(env.envelopeId)) {
    return {
      valid: false,
      code: 'MALFORMED_ENVELOPE',
      reason: 'Missing or empty envelopeId',
    };
  }

  if (!isNonEmptyString(env.aggregateType)) {
    return {
      valid: false,
      code: 'MALFORMED_ENVELOPE',
      reason: 'Missing or empty aggregateType',
    };
  }

  if (!isNonEmptyString(env.aggregateId)) {
    return {
      valid: false,
      code: 'MALFORMED_ENVELOPE',
      reason: 'Missing or empty aggregateId',
    };
  }

  return { valid: true };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate an envelope's structural integrity.
 * Returns a discriminated result — never throws.
 */
export function validateEnvelope(envelope: SyncEnvelope): ValidationResult {
  const common = validateCommonFields(envelope);
  if (!common.valid) {
    return common;
  }

  return validateCommandFields(envelope);
}
