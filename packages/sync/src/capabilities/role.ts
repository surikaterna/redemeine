import type { NodeCapabilities } from './capabilities';

/**
 * Discriminated union of topology roles a node can assume.
 *
 * - `origin`  — authoritative upstream; never syncs commands upstream,
 *               may relay downstream.
 * - `relay`   — intermediary; syncs commands upstream *and* relays
 *               data downstream (e.g. a regional server).
 * - `leaf`    — edge consumer; syncs commands upstream, never relays
 *               downstream (e.g. a disconnected device).
 */
export type NodeRole = 'origin' | 'relay' | 'leaf';

/**
 * Infers the {@link NodeRole} from a given capability set.
 *
 * Resolution rules (evaluated in order):
 * 1. No upstream sync → `origin` (node is the authority).
 * 2. Upstream sync + downstream relay → `relay`.
 * 3. Upstream sync + no downstream relay → `leaf`.
 */
export const resolveRole = (capabilities: NodeCapabilities): NodeRole => {
  if (!capabilities.upstreamSync) {
    return 'origin';
  }
  return capabilities.downstreamRelay ? 'relay' : 'leaf';
};
