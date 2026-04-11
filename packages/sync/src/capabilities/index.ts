// Capability-driven runtime contracts — barrel exports

export type { NodeCapabilities } from './capabilities';
export type { NodeRole } from './role';
export { resolveRole } from './role';
export type { NodeIdentity } from './identity';
export { createNodeIdentity } from './identity';
export {
  createOriginCapabilities,
  createRelayCapabilities,
  createLeafCapabilities,
} from './presets';
