import type { NodeCapabilities } from './capabilities';

/**
 * Preset: origin node capabilities.
 *
 * An origin is the authoritative source of truth.  It does not sync
 * commands upstream (it *is* upstream) and does not process commands
 * optimistically — all events are immediately authoritative.
 */
export const createOriginCapabilities = (): NodeCapabilities => ({
  durableEventStore: true,
  upstreamSync: false,
  downstreamRelay: true,
  optimisticProcessing: false,
  scheduler: true,
  projectionRuntime: true,
});

/**
 * Preset: relay node capabilities.
 *
 * A relay sits between an origin (or parent relay) and leaf nodes.
 * It syncs commands upstream, relays data downstream, and processes
 * commands optimistically while awaiting authoritative confirmation.
 */
export const createRelayCapabilities = (): NodeCapabilities => ({
  durableEventStore: true,
  upstreamSync: true,
  downstreamRelay: true,
  optimisticProcessing: true,
  scheduler: true,
  projectionRuntime: true,
});

/**
 * Preset: leaf node capabilities.
 *
 * A leaf is a lightweight edge consumer (e.g. a disconnected device).
 * It syncs commands upstream and processes optimistically, but does not
 * relay downstream and has no durable scheduler.
 */
export const createLeafCapabilities = (): NodeCapabilities => ({
  durableEventStore: true,
  upstreamSync: true,
  downstreamRelay: false,
  optimisticProcessing: true,
  scheduler: false,
  projectionRuntime: false,
});
