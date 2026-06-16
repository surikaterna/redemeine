// ---------------------------------------------------------------------------
// scomp Feed Contract Types — Downstream Sync
// ---------------------------------------------------------------------------

import type { EventStreamEnvelope } from './event-stream-envelope';
import type { ProjectionEnvelope } from './projection-envelope';
import type { ConfigEnvelope } from './config-envelope';

// ---------------------------------------------------------------------------
// Feed input types
// ---------------------------------------------------------------------------

/**
 * Input parameters for an event stream feed subscription.
 * The downstream node identifies itself and optionally provides
 * a checkpoint to resume from.
 */
export interface EventStreamFeedInput {
  /** Downstream node identifier. */
  readonly nodeId: string;

  /**
   * Opaque checkpoint token to resume from.
   * When omitted, the feed starts from the beginning.
   */
  readonly fromCheckpoint?: string;
}

/**
 * Input parameters for a projection or master data feed subscription.
 * Both lanes share the same input shape — the {@link lane} field
 * disambiguates at the protocol level.
 */
export interface ProjectionFeedInput {
  /** Downstream node identifier. */
  readonly nodeId: string;

  /** Which lane this subscription targets. */
  readonly lane: 'projections' | 'masterData';

  /**
   * Opaque checkpoint token to resume from.
   * When omitted, the feed starts from the beginning.
   */
  readonly fromCheckpoint?: string;
}

/**
 * Input parameters for a configuration feed subscription.
 */
export interface ConfigFeedInput {
  /** Downstream node identifier. */
  readonly nodeId: string;

  /**
   * Opaque checkpoint token to resume from.
   * When omitted, the feed starts from the beginning.
   */
  readonly fromCheckpoint?: string;
}

// ---------------------------------------------------------------------------
// Service contract
// ---------------------------------------------------------------------------

/**
 * scomp feed contract for downstream replication.
 *
 * Each method returns an `AsyncIterable` of typed envelopes.
 * The upstream node implements this interface and exposes it
 * via scomp. Downstream nodes consume the feeds to replicate
 * data across the sync topology.
 *
 * Upstream internally uses its Sync Manifest to determine which
 * data enters each feed — the downstream consumer is manifest-unaware.
 *
 * Four lanes are exposed:
 * - **eventStream** — aggregate event streams (snapshot + events + lifecycle signals)
 * - **projectionStream** — pre-computed read model documents
 * - **masterDataStream** — reference/master data (same envelope, semantic distinction)
 * - **configStream** — namespace-scoped configuration
 */
export interface DownstreamSyncService {
  /**
   * Opens an event stream feed for the requesting downstream node.
   * Delivers aggregate snapshots, event batches, and lifecycle signals
   * for all streams matching the node's manifest selectors.
   */
  eventStream(input: EventStreamFeedInput): AsyncIterable<EventStreamEnvelope>;

  /**
   * Opens a projection feed for the requesting downstream node.
   * Delivers projection snapshots, deltas, and removal signals.
   */
  projectionStream(input: ProjectionFeedInput): AsyncIterable<ProjectionEnvelope>;

  /**
   * Opens a master data feed for the requesting downstream node.
   * Uses the same envelope type as projections — the semantic
   * distinction is at the lane level, not the envelope level.
   */
  masterDataStream(input: ProjectionFeedInput): AsyncIterable<ProjectionEnvelope>;

  /**
   * Opens a configuration feed for the requesting downstream node.
   * Delivers namespace snapshots and deltas.
   */
  configStream(input: ConfigFeedInput): AsyncIterable<ConfigEnvelope>;
}
