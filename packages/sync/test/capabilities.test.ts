import { describe, expect, it } from 'bun:test';

import type { NodeCapabilities, NodeIdentity, NodeRole } from '../src/capabilities';
import {
  createLeafCapabilities,
  createNodeIdentity,
  createOriginCapabilities,
  createRelayCapabilities,
  resolveRole,
} from '../src/capabilities';

// ---------------------------------------------------------------------------
// Role presets
// ---------------------------------------------------------------------------

describe('createOriginCapabilities', () => {
  const caps = createOriginCapabilities();

  it('enables durable event store', () => {
    expect(caps.durableEventStore).toBe(true);
  });

  it('disables upstream sync (origin IS the authority)', () => {
    expect(caps.upstreamSync).toBe(false);
  });

  it('enables downstream relay', () => {
    expect(caps.downstreamRelay).toBe(true);
  });

  it('disables optimistic processing', () => {
    expect(caps.optimisticProcessing).toBe(false);
  });

  it('enables scheduler', () => {
    expect(caps.scheduler).toBe(true);
  });

  it('enables projection runtime', () => {
    expect(caps.projectionRuntime).toBe(true);
  });
});

describe('createRelayCapabilities', () => {
  const caps = createRelayCapabilities();

  it('enables all capabilities', () => {
    expect(caps.durableEventStore).toBe(true);
    expect(caps.upstreamSync).toBe(true);
    expect(caps.downstreamRelay).toBe(true);
    expect(caps.optimisticProcessing).toBe(true);
    expect(caps.scheduler).toBe(true);
    expect(caps.projectionRuntime).toBe(true);
  });
});

describe('createLeafCapabilities', () => {
  const caps = createLeafCapabilities();

  it('enables durable event store', () => {
    expect(caps.durableEventStore).toBe(true);
  });

  it('enables upstream sync', () => {
    expect(caps.upstreamSync).toBe(true);
  });

  it('disables downstream relay', () => {
    expect(caps.downstreamRelay).toBe(false);
  });

  it('enables optimistic processing', () => {
    expect(caps.optimisticProcessing).toBe(true);
  });

  it('disables scheduler', () => {
    expect(caps.scheduler).toBe(false);
  });

  it('disables projection runtime', () => {
    expect(caps.projectionRuntime).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resolveRole
// ---------------------------------------------------------------------------

describe('resolveRole', () => {
  it('resolves origin when upstreamSync is false', () => {
    expect(resolveRole(createOriginCapabilities())).toBe('origin');
  });

  it('resolves relay when upstreamSync AND downstreamRelay are true', () => {
    expect(resolveRole(createRelayCapabilities())).toBe('relay');
  });

  it('resolves leaf when upstreamSync is true and downstreamRelay is false', () => {
    expect(resolveRole(createLeafCapabilities())).toBe('leaf');
  });

  it('resolves origin for custom capabilities without upstream sync', () => {
    const custom: NodeCapabilities = {
      durableEventStore: false,
      upstreamSync: false,
      downstreamRelay: false,
      optimisticProcessing: false,
      scheduler: false,
      projectionRuntime: false,
    };
    expect(resolveRole(custom)).toBe('origin');
  });

  it('resolves leaf for custom capabilities with upstream sync but no relay', () => {
    const custom: NodeCapabilities = {
      durableEventStore: true,
      upstreamSync: true,
      downstreamRelay: false,
      optimisticProcessing: false,
      scheduler: false,
      projectionRuntime: false,
    };
    expect(resolveRole(custom)).toBe('leaf');
  });

  it('resolves relay for custom capabilities with upstream sync and relay', () => {
    const custom: NodeCapabilities = {
      durableEventStore: false,
      upstreamSync: true,
      downstreamRelay: true,
      optimisticProcessing: false,
      scheduler: false,
      projectionRuntime: false,
    };
    expect(resolveRole(custom)).toBe('relay');
  });
});

// ---------------------------------------------------------------------------
// createNodeIdentity
// ---------------------------------------------------------------------------

describe('createNodeIdentity', () => {
  it('creates an identity with auto-resolved origin role', () => {
    const identity = createNodeIdentity('node-1', 'tenant-a', createOriginCapabilities());

    expect(identity.nodeId).toBe('node-1');
    expect(identity.tenant).toBe('tenant-a');
    expect(identity.role).toBe('origin');
    expect(identity.capabilities).toEqual(createOriginCapabilities());
  });

  it('creates an identity with auto-resolved relay role', () => {
    const identity = createNodeIdentity('node-2', 'tenant-b', createRelayCapabilities());

    expect(identity.nodeId).toBe('node-2');
    expect(identity.tenant).toBe('tenant-b');
    expect(identity.role).toBe('relay');
  });

  it('creates an identity with auto-resolved leaf role', () => {
    const identity = createNodeIdentity('node-3', 'tenant-c', createLeafCapabilities());

    expect(identity.nodeId).toBe('node-3');
    expect(identity.tenant).toBe('tenant-c');
    expect(identity.role).toBe('leaf');
  });

  it('preserves the full capabilities object', () => {
    const caps = createLeafCapabilities();
    const identity = createNodeIdentity('n', 't', caps);

    expect(identity.capabilities).toEqual(caps);
  });
});

// ---------------------------------------------------------------------------
// Type-level compile checks
// ---------------------------------------------------------------------------

describe('type-level checks', () => {
  it('NodeCapabilities compiles with all required fields', () => {
    const caps: NodeCapabilities = {
      durableEventStore: true,
      upstreamSync: false,
      downstreamRelay: true,
      optimisticProcessing: false,
      scheduler: true,
      projectionRuntime: true,
    };
    // If this compiles, the interface shape is correct.
    expect(caps).toBeDefined();
  });

  it('NodeRole accepts valid role strings', () => {
    const roles: NodeRole[] = ['origin', 'relay', 'leaf'];
    expect(roles).toHaveLength(3);
  });

  it('NodeIdentity compiles with all required fields', () => {
    const identity: NodeIdentity = {
      nodeId: 'id',
      tenant: 'tenant',
      capabilities: createOriginCapabilities(),
      role: 'origin',
    };
    expect(identity).toBeDefined();
  });
});
