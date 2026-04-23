import { describe, expect, it } from 'bun:test';
import {
  type SyncManifest,
  type LaneSelector,
  type EventStreamSelector,
  type ProjectionSelector,
  type MasterDataSelector,
  type ConfigurationSelector,
  type ManifestDelta,
  type ManifestLifecycleSignal,
  computeManifestDelta,
  deriveLifecycleSignals,
  groupSelectorsByLane,
  selectorIdentityKey,
  SYNC_LANES,
} from '../src/manifest';
import { deriveChildManifest } from '../src/manifest/hierarchy';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeManifest(
  overrides: Partial<SyncManifest> & { selectors: ReadonlyArray<LaneSelector> },
): SyncManifest {
  return {
    nodeId: 'node-1',
    version: 1,
    etag: 'test-etag',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// SyncLane constants
// ---------------------------------------------------------------------------

describe('SyncLane', () => {
  it('has exactly four lanes', () => {
    expect(SYNC_LANES).toEqual(['events', 'projections', 'masterData', 'configuration']);
  });
});

// ---------------------------------------------------------------------------
// Lane selector type narrowing
// ---------------------------------------------------------------------------

describe('LaneSelector type narrowing', () => {
  it('narrows EventStreamSelector on lane === "events"', () => {
    const selector: LaneSelector = {
      lane: 'events',
      aggregateType: 'Order',
    };
    if (selector.lane === 'events') {
      // TypeScript narrows to EventStreamSelector
      const _agg: string = selector.aggregateType;
      expect(_agg).toBe('Order');
    }
  });

  it('narrows ProjectionSelector on lane === "projections"', () => {
    const selector: LaneSelector = {
      lane: 'projections',
      projectionName: 'OrderSummary',
    };
    if (selector.lane === 'projections') {
      const _name: string = selector.projectionName;
      expect(_name).toBe('OrderSummary');
    }
  });

  it('narrows MasterDataSelector on lane === "masterData"', () => {
    const selector: LaneSelector = {
      lane: 'masterData',
      projectionName: 'Locations',
    };
    if (selector.lane === 'masterData') {
      const _name: string = selector.projectionName;
      expect(_name).toBe('Locations');
    }
  });

  it('narrows ConfigurationSelector on lane === "configuration"', () => {
    const selector: LaneSelector = {
      lane: 'configuration',
      namespace: 'feature-flags',
    };
    if (selector.lane === 'configuration') {
      const _ns: string = selector.namespace;
      expect(_ns).toBe('feature-flags');
    }
  });
});

// ---------------------------------------------------------------------------
// selectorIdentityKey
// ---------------------------------------------------------------------------

describe('selectorIdentityKey', () => {
  it('returns lane:aggregateType for events', () => {
    const sel: EventStreamSelector = { lane: 'events', aggregateType: 'Order' };
    expect(selectorIdentityKey(sel)).toBe('events:Order');
  });

  it('returns lane:projectionName for projections', () => {
    const sel: ProjectionSelector = { lane: 'projections', projectionName: 'Summary' };
    expect(selectorIdentityKey(sel)).toBe('projections:Summary');
  });

  it('returns lane:projectionName for masterData', () => {
    const sel: MasterDataSelector = { lane: 'masterData', projectionName: 'Locations' };
    expect(selectorIdentityKey(sel)).toBe('masterData:Locations');
  });

  it('returns lane:namespace for configuration', () => {
    const sel: ConfigurationSelector = { lane: 'configuration', namespace: 'flags' };
    expect(selectorIdentityKey(sel)).toBe('configuration:flags');
  });
});

// ---------------------------------------------------------------------------
// groupSelectorsByLane
// ---------------------------------------------------------------------------

describe('groupSelectorsByLane', () => {
  it('groups mixed selectors into their respective lanes', () => {
    const selectors: ReadonlyArray<LaneSelector> = [
      { lane: 'events', aggregateType: 'A' },
      { lane: 'projections', projectionName: 'P1' },
      { lane: 'events', aggregateType: 'B' },
      { lane: 'configuration', namespace: 'ns' },
      { lane: 'masterData', projectionName: 'MD' },
    ];

    const grouped = groupSelectorsByLane(selectors);
    expect(grouped.events).toHaveLength(2);
    expect(grouped.projections).toHaveLength(1);
    expect(grouped.masterData).toHaveLength(1);
    expect(grouped.configuration).toHaveLength(1);
  });

  it('returns empty arrays for lanes with no selectors', () => {
    const grouped = groupSelectorsByLane([]);
    expect(grouped.events).toHaveLength(0);
    expect(grouped.projections).toHaveLength(0);
    expect(grouped.masterData).toHaveLength(0);
    expect(grouped.configuration).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// computeManifestDelta
// ---------------------------------------------------------------------------

describe('computeManifestDelta', () => {
  it('detects added selectors', () => {
    const previous = makeManifest({ version: 1, selectors: [] });
    const current = makeManifest({
      version: 2,
      selectors: [{ lane: 'events', aggregateType: 'Order' }],
    });

    const delta = computeManifestDelta(previous, current);

    expect(delta.nodeId).toBe('node-1');
    expect(delta.fromVersion).toBe(1);
    expect(delta.toVersion).toBe(2);
    expect(delta.added).toHaveLength(1);
    expect(delta.removed).toHaveLength(0);
    expect(delta.changed).toHaveLength(0);
    expect((delta.added[0] as EventStreamSelector).aggregateType).toBe('Order');
  });

  it('detects removed selectors', () => {
    const previous = makeManifest({
      version: 1,
      selectors: [
        { lane: 'events', aggregateType: 'Order' },
        { lane: 'projections', projectionName: 'Summary' },
      ],
    });
    const current = makeManifest({
      version: 2,
      selectors: [{ lane: 'events', aggregateType: 'Order' }],
    });

    const delta = computeManifestDelta(previous, current);

    expect(delta.added).toHaveLength(0);
    expect(delta.removed).toHaveLength(1);
    expect(delta.changed).toHaveLength(0);
    expect((delta.removed[0] as ProjectionSelector).projectionName).toBe('Summary');
  });

  it('detects changed selectors (same identity key, different filter)', () => {
    const previous = makeManifest({
      version: 1,
      selectors: [
        {
          lane: 'events',
          aggregateType: 'Order',
          filter: { expression: 'status = "active"' },
        },
      ],
    });
    const current = makeManifest({
      version: 2,
      selectors: [
        {
          lane: 'events',
          aggregateType: 'Order',
          filter: { expression: 'status = "completed"' },
        },
      ],
    });

    const delta = computeManifestDelta(previous, current);

    expect(delta.added).toHaveLength(0);
    expect(delta.removed).toHaveLength(0);
    expect(delta.changed).toHaveLength(1);
    expect((delta.changed[0] as EventStreamSelector).aggregateType).toBe('Order');
  });

  it('detects a mix of added, removed, and changed selectors', () => {
    const previous = makeManifest({
      version: 3,
      selectors: [
        { lane: 'events', aggregateType: 'Order' },
        { lane: 'projections', projectionName: 'OldProj' },
        {
          lane: 'masterData',
          projectionName: 'Locations',
          filter: { expression: 'region = "EU"' },
        },
      ],
    });
    const current = makeManifest({
      version: 4,
      selectors: [
        { lane: 'events', aggregateType: 'Order' }, // unchanged
        { lane: 'configuration', namespace: 'flags' }, // added
        {
          lane: 'masterData',
          projectionName: 'Locations',
          filter: { expression: 'region = "US"' },
        }, // changed
        // 'projections:OldProj' removed
      ],
    });

    const delta = computeManifestDelta(previous, current);

    expect(delta.fromVersion).toBe(3);
    expect(delta.toVersion).toBe(4);
    expect(delta.added).toHaveLength(1);
    expect(delta.removed).toHaveLength(1);
    expect(delta.changed).toHaveLength(1);
  });

  it('returns empty delta when manifests are identical', () => {
    const selectors: ReadonlyArray<LaneSelector> = [
      { lane: 'events', aggregateType: 'Order' },
    ];
    const previous = makeManifest({ version: 5, selectors });
    const current = makeManifest({ version: 6, selectors });

    const delta = computeManifestDelta(previous, current);

    expect(delta.added).toHaveLength(0);
    expect(delta.removed).toHaveLength(0);
    expect(delta.changed).toHaveLength(0);
  });

  it('includes computedAt as a valid ISO timestamp', () => {
    const delta = computeManifestDelta(
      makeManifest({ version: 1, selectors: [] }),
      makeManifest({ version: 2, selectors: [] }),
    );
    expect(new Date(delta.computedAt).toISOString()).toBe(delta.computedAt);
  });
});

// ---------------------------------------------------------------------------
// deriveLifecycleSignals
// ---------------------------------------------------------------------------

describe('deriveLifecycleSignals', () => {
  it('produces stream_added signals for added selectors', () => {
    const delta: ManifestDelta = {
      nodeId: 'node-1',
      fromVersion: 1,
      toVersion: 2,
      added: [{ lane: 'events', aggregateType: 'Order' }],
      removed: [],
      changed: [],
      computedAt: '2026-01-01T00:00:00Z',
    };

    const signals = deriveLifecycleSignals(delta);

    expect(signals).toHaveLength(1);
    expect(signals[0].type).toBe('stream_added');
    expect((signals[0].selector as EventStreamSelector).aggregateType).toBe('Order');
  });

  it('produces stream_removed signals for removed selectors', () => {
    const delta: ManifestDelta = {
      nodeId: 'node-1',
      fromVersion: 1,
      toVersion: 2,
      added: [],
      removed: [{ lane: 'projections', projectionName: 'Summary' }],
      changed: [],
      computedAt: '2026-01-01T00:00:00Z',
    };

    const signals = deriveLifecycleSignals(delta);

    expect(signals).toHaveLength(1);
    expect(signals[0].type).toBe('stream_removed');
  });

  it('does not produce signals for changed selectors', () => {
    const delta: ManifestDelta = {
      nodeId: 'node-1',
      fromVersion: 1,
      toVersion: 2,
      added: [],
      removed: [],
      changed: [{ lane: 'events', aggregateType: 'Order' }],
      computedAt: '2026-01-01T00:00:00Z',
    };

    const signals = deriveLifecycleSignals(delta);
    expect(signals).toHaveLength(0);
  });

  it('produces signals for both added and removed in one delta', () => {
    const delta: ManifestDelta = {
      nodeId: 'node-1',
      fromVersion: 1,
      toVersion: 2,
      added: [
        { lane: 'events', aggregateType: 'Order' },
        { lane: 'configuration', namespace: 'flags' },
      ],
      removed: [{ lane: 'masterData', projectionName: 'Locations' }],
      changed: [],
      computedAt: '2026-01-01T00:00:00Z',
    };

    const signals = deriveLifecycleSignals(delta);

    expect(signals).toHaveLength(3);
    const addedSignals = signals.filter((s) => s.type === 'stream_added');
    const removedSignals = signals.filter((s) => s.type === 'stream_removed');
    expect(addedSignals).toHaveLength(2);
    expect(removedSignals).toHaveLength(1);
  });

  it('returns empty array for empty delta', () => {
    const delta: ManifestDelta = {
      nodeId: 'node-1',
      fromVersion: 1,
      toVersion: 2,
      added: [],
      removed: [],
      changed: [],
      computedAt: '2026-01-01T00:00:00Z',
    };

    expect(deriveLifecycleSignals(delta)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// deriveChildManifest
// ---------------------------------------------------------------------------

describe('deriveChildManifest', () => {
  const parentSelectors: ReadonlyArray<LaneSelector> = [
    { lane: 'events', aggregateType: 'Order' },
    { lane: 'events', aggregateType: 'Shipment' },
    { lane: 'projections', projectionName: 'Dashboard' },
    { lane: 'configuration', namespace: 'flags' },
    { lane: 'masterData', projectionName: 'Locations' },
  ];

  const parent = makeManifest({
    nodeId: 'relay-1',
    version: 10,
    selectors: parentSelectors,
  });

  it('filters selectors using the subset predicate', () => {
    const child = deriveChildManifest(
      parent,
      'leaf-1',
      (sel) => sel.lane === 'events',
    );

    expect(child.nodeId).toBe('leaf-1');
    expect(child.selectors).toHaveLength(2);
    expect(child.selectors.every((s) => s.lane === 'events')).toBe(true);
  });

  it('increments version from parent', () => {
    const child = deriveChildManifest(parent, 'leaf-1', () => true);
    expect(child.version).toBe(11);
  });

  it('produces a valid etag', () => {
    const child = deriveChildManifest(parent, 'leaf-1', () => true);
    expect(typeof child.etag).toBe('string');
    expect(child.etag.length).toBeGreaterThan(0);
  });

  it('produces deterministic etag for identical selector sets', () => {
    const child1 = deriveChildManifest(parent, 'leaf-1', (s) => s.lane === 'events');
    const child2 = deriveChildManifest(parent, 'leaf-2', (s) => s.lane === 'events');

    // Same selectors → same etag, even with different nodeId
    expect(child1.etag).toBe(child2.etag);
  });

  it('returns empty selectors when filter matches nothing', () => {
    const child = deriveChildManifest(parent, 'leaf-1', () => false);

    expect(child.selectors).toHaveLength(0);
    expect(child.nodeId).toBe('leaf-1');
  });

  it('sets updatedAt to a valid ISO timestamp', () => {
    const child = deriveChildManifest(parent, 'leaf-1', () => true);
    expect(new Date(child.updatedAt).toISOString()).toBe(child.updatedAt);
  });
});

// ---------------------------------------------------------------------------
// Manifest versioning
// ---------------------------------------------------------------------------

describe('Manifest versioning', () => {
  it('version is monotonically increasing across deltas', () => {
    const v1 = makeManifest({ version: 1, selectors: [] });
    const v2 = makeManifest({
      version: 2,
      selectors: [{ lane: 'events', aggregateType: 'A' }],
    });
    const v3 = makeManifest({
      version: 3,
      selectors: [
        { lane: 'events', aggregateType: 'A' },
        { lane: 'events', aggregateType: 'B' },
      ],
    });

    const delta1 = computeManifestDelta(v1, v2);
    const delta2 = computeManifestDelta(v2, v3);

    expect(delta1.fromVersion).toBe(1);
    expect(delta1.toVersion).toBe(2);
    expect(delta2.fromVersion).toBe(2);
    expect(delta2.toVersion).toBe(3);
    expect(delta2.toVersion).toBeGreaterThan(delta1.toVersion);
  });
});
