import type { NodeCapabilities } from './capabilities';
import type { NodeRole } from './role';
import { resolveRole } from './role';

/**
 * Identifies a node within the sync topology.
 *
 * Combines a unique node id, a tenant scope, the declared capabilities,
 * and the convenience role derived from those capabilities.
 */
export interface NodeIdentity {
  /** Unique identifier for this node. */
  readonly nodeId: string;

  /** Tenant this node belongs to. */
  readonly tenant: string;

  /** Declared capability set. */
  readonly capabilities: NodeCapabilities;

  /** Convenience role derived from {@link capabilities}. */
  readonly role: NodeRole;
}

/**
 * Creates a {@link NodeIdentity}, automatically resolving the role
 * from the provided capabilities.
 */
export const createNodeIdentity = (
  nodeId: string,
  tenant: string,
  capabilities: NodeCapabilities,
): NodeIdentity => ({
  nodeId,
  tenant,
  capabilities,
  role: resolveRole(capabilities),
});
