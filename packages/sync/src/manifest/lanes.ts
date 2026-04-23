/**
 * The four sync lanes that a manifest can reference.
 *
 * Each lane carries a distinct category of data from upstream to downstream:
 * - events: aggregate event streams (snapshot + tail)
 * - projections: pre-computed read models
 * - masterData: reference/master data (same mechanism as projections, semantically distinct)
 * - configuration: namespace-scoped config snapshots + deltas
 */
export type SyncLane = 'events' | 'projections' | 'masterData' | 'configuration';

/** All valid lane values as a readonly tuple for runtime validation. */
export const SYNC_LANES: ReadonlyArray<SyncLane> = [
  'events',
  'projections',
  'masterData',
  'configuration',
] as const;
