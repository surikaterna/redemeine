import type { SyncLane } from './lanes';

// ---------------------------------------------------------------------------
// Filter expression (opaque — evaluated by consumer-provided rule engine)
// ---------------------------------------------------------------------------

/**
 * An opaque filter expression attached to a lane selector.
 * The `expression` string is parsed and evaluated by the consumer-provided
 * rule engine; the framework never interprets it.
 */
export interface SelectorFilter {
  readonly expression: string;
  readonly params?: Readonly<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Per-lane selector discriminated unions
// ---------------------------------------------------------------------------

/** Selects an aggregate event stream by type, with an optional filter. */
export interface EventStreamSelector {
  readonly lane: 'events';
  readonly aggregateType: string;
  readonly filter?: SelectorFilter;
}

/** Selects a projection by name, with an optional filter. */
export interface ProjectionSelector {
  readonly lane: 'projections';
  readonly projectionName: string;
  readonly filter?: SelectorFilter;
}

/** Selects master data by projection name, with an optional filter. */
export interface MasterDataSelector {
  readonly lane: 'masterData';
  readonly projectionName: string;
  readonly filter?: SelectorFilter;
}

/** Selects a configuration namespace (no filter — config is all-or-nothing). */
export interface ConfigurationSelector {
  readonly lane: 'configuration';
  readonly namespace: string;
}

// ---------------------------------------------------------------------------
// Union type
// ---------------------------------------------------------------------------

/** Discriminated union of all lane selectors — narrow on `lane`. */
export type LaneSelector =
  | EventStreamSelector
  | ProjectionSelector
  | MasterDataSelector
  | ConfigurationSelector;

// ---------------------------------------------------------------------------
// Identity key extraction (used by delta computation)
// ---------------------------------------------------------------------------

/**
 * Returns a stable identity key for a selector, unique within its lane.
 * Two selectors with the same identity key refer to the same logical stream;
 * their filters may differ (which constitutes a "changed" selector).
 */
export function selectorIdentityKey(selector: LaneSelector): string {
  switch (selector.lane) {
    case 'events':
      return `events:${selector.aggregateType}`;
    case 'projections':
      return `projections:${selector.projectionName}`;
    case 'masterData':
      return `masterData:${selector.projectionName}`;
    case 'configuration':
      return `configuration:${selector.namespace}`;
  }
}
