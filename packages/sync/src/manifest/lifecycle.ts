import type { LaneSelector } from './selectors';
import type { ManifestDelta } from './delta';

// ---------------------------------------------------------------------------
// Lifecycle signals — derived from manifest deltas
// ---------------------------------------------------------------------------

/**
 * Signal emitted when a new selector is added to the manifest.
 * Upstream should prepare data (e.g. snapshot + event tail) for this selector.
 */
export interface StreamAddedSignal {
  readonly type: 'stream_added';
  readonly selector: LaneSelector;
}

/**
 * Signal emitted when a selector is removed from the manifest.
 * Downstream should prune any locally-cached data for this selector.
 */
export interface StreamRemovedSignal {
  readonly type: 'stream_removed';
  readonly selector: LaneSelector;
}

/** Discriminated union of all manifest lifecycle signals. */
export type ManifestLifecycleSignal = StreamAddedSignal | StreamRemovedSignal;

// ---------------------------------------------------------------------------
// Signal derivation — pure function
// ---------------------------------------------------------------------------

/**
 * Derives lifecycle signals from a manifest delta.
 *
 * - Each **added** selector produces a `stream_added` signal.
 * - Each **removed** selector produces a `stream_removed` signal.
 * - **Changed** selectors do not produce lifecycle signals — they represent
 *   filter modifications on an already-active stream.
 *
 * Pure function — no side effects.
 */
export function deriveLifecycleSignals(
  delta: ManifestDelta,
): ReadonlyArray<ManifestLifecycleSignal> {
  const signals: Array<ManifestLifecycleSignal> = [];

  for (const selector of delta.added) {
    signals.push({ type: 'stream_added', selector });
  }

  for (const selector of delta.removed) {
    signals.push({ type: 'stream_removed', selector });
  }

  return signals;
}
