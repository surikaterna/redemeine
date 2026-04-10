import type { Checkpoint } from '../types';

export const PROJECTION_DEDUPE_KEY_VERSION = 'v1' as const;

export type ProjectionDedupeKeyVersion = typeof PROJECTION_DEDUPE_KEY_VERSION;

export type ProjectionDedupeKeyEncoded = string;

export interface ProjectionDedupeKey {
  version: ProjectionDedupeKeyVersion;
  projectionName: string;
  aggregateType: string;
  aggregateId: string;
  sequence: number;
}

export interface ProjectionDedupeRetentionCleanupPolicy {
  mode: 'lazy' | 'scheduled';
  maxDeletesPerRun?: number;
}

export interface ProjectionDedupeRetentionPolicy {
  /**
   * Safety overlap window that MUST be retained to protect replay/retry overlap.
   */
  windowMs: number;

  /**
   * Time-to-live for dedupe entries. Entries at or beyond this age are cleanup-eligible.
   */
  ttlMs: number;

  /**
   * Optional scheduler contract for cleanup behavior.
   */
  cleanup?: ProjectionDedupeRetentionCleanupPolicy;
}

export type ProjectionDedupeRetentionDisposition = 'retain' | 'eligible_for_cleanup';

export interface ProjectionDedupeRetentionEvaluationInput {
  policy: ProjectionDedupeRetentionPolicy;
  checkpoint: Checkpoint;
  now: Date | number;
}

export function encodeProjectionDedupeKey(key: Omit<ProjectionDedupeKey, 'version'>): ProjectionDedupeKeyEncoded {
  return [
    PROJECTION_DEDUPE_KEY_VERSION,
    encodeURIComponent(key.projectionName),
    encodeURIComponent(key.aggregateType),
    encodeURIComponent(key.aggregateId),
    key.sequence.toString(10)
  ].join('|');
}

export function decodeProjectionDedupeKey(encoded: ProjectionDedupeKeyEncoded): ProjectionDedupeKey | null {
  const parts = encoded.split('|');
  if (parts.length !== 5 || parts[0] !== PROJECTION_DEDUPE_KEY_VERSION) {
    return null;
  }

  const sequence = Number.parseInt(parts[4] ?? '', 10);
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    return null;
  }

  try {
    return {
      version: PROJECTION_DEDUPE_KEY_VERSION,
      projectionName: decodeURIComponent(parts[1] ?? ''),
      aggregateType: decodeURIComponent(parts[2] ?? ''),
      aggregateId: decodeURIComponent(parts[3] ?? ''),
      sequence
    };
  } catch {
    return null;
  }
}

export function evaluateProjectionDedupeRetention(
  input: ProjectionDedupeRetentionEvaluationInput
): ProjectionDedupeRetentionDisposition {
  const { policy, checkpoint } = input;
  const nowMs = input.now instanceof Date ? input.now.getTime() : input.now;

  if (policy.windowMs < 0 || policy.ttlMs < 0 || policy.ttlMs < policy.windowMs) {
    throw new Error('Invalid dedupe retention policy: expected ttlMs >= windowMs >= 0.');
  }

  if (!checkpoint.timestamp) {
    return 'retain';
  }

  const checkpointMs = Date.parse(checkpoint.timestamp);
  if (!Number.isFinite(checkpointMs)) {
    return 'retain';
  }

  const ageMs = Math.max(0, nowMs - checkpointMs);
  if (ageMs < policy.windowMs) {
    return 'retain';
  }

  return ageMs >= policy.ttlMs ? 'eligible_for_cleanup' : 'retain';
}
