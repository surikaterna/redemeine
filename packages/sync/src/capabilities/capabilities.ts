/**
 * Capability declaration contract.
 *
 * Each boolean field represents a discrete runtime capability a node can
 * declare.  The runtime branches behavior at initialization based on
 * which capabilities are enabled — the same framework packages deploy
 * unchanged at origin, relay, or leaf nodes.
 */

export interface NodeCapabilities {
  /** Node has a persistent, crash-safe event store. */
  readonly durableEventStore: boolean;

  /** Node can submit commands upstream (implies it is not the authority). */
  readonly upstreamSync: boolean;

  /** Node can relay authoritative data to child nodes. */
  readonly downstreamRelay: boolean;

  /**
   * Node processes commands optimistically, producing pending events that
   * are later confirmed or superseded by authoritative upstream events.
   */
  readonly optimisticProcessing: boolean;

  /** Node has a durable, crash-safe scheduler for deferred work. */
  readonly scheduler: boolean;

  /** Node runs local read-model projections. */
  readonly projectionRuntime: boolean;
}
