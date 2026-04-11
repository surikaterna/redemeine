import { describe, test, expect } from 'bun:test';
import type {
  SyncHealthMetrics,
  PendingEventSummary,
  LaneLagMetrics,
  SyncAlert,
  ConnectionChangedAlert,
  QueueDepthThresholdAlert,
  SyncLagThresholdAlert,
  PendingEventThresholdAlert,
  IMetricSink,
  HealthSnapshotDependencies,
  SyncHealthThresholds,
} from '../src/health';
import {
  defaultThresholds,
  checkThresholds,
  captureHealthSnapshot,
} from '../src/health';
import type { ConnectionState, IConnectionMonitor } from '../src/upstream';
import type { ICommandQueue, ICheckpointStore, Checkpoint } from '../src/store';
import type { SyncLane } from '../src/store';

// ---------------------------------------------------------------------------
// Type-level helpers
// ---------------------------------------------------------------------------

type AssertExtends<T extends U, U> = T;

// ---------------------------------------------------------------------------
// SyncHealthMetrics — type shape
// ---------------------------------------------------------------------------

describe('SyncHealthMetrics', () => {
  test('compiles with all required fields', () => {
    const metrics: SyncHealthMetrics = {
      connectionStatus: 'online',
      commandQueueDepth: 5,
      pendingEventCount: { total: 3, byStream: { 'stream-1': 2, 'stream-2': 1 } },
      perLaneSyncLag: {
        events: { localCheckpoint: 'cp-1', upstreamHead: 'head-1', estimatedLag: 500 },
        projections: { localCheckpoint: undefined, upstreamHead: undefined, estimatedLag: undefined },
        masterData: { localCheckpoint: 'cp-2', upstreamHead: undefined, estimatedLag: undefined },
        configuration: { localCheckpoint: 'cp-3', upstreamHead: 'head-3', estimatedLag: 0 },
      },
      lastSyncTimestamp: {
        events: '2026-01-01T00:00:00Z',
        projections: undefined,
        masterData: '2026-01-01T00:01:00Z',
        configuration: '2026-01-01T00:02:00Z',
      },
      nodeId: 'node-1',
      capturedAt: '2026-01-01T00:03:00Z',
    };

    expect(metrics.connectionStatus).toBe('online');
    expect(metrics.commandQueueDepth).toBe(5);
    expect(metrics.pendingEventCount.total).toBe(3);
    expect(metrics.nodeId).toBe('node-1');
  });

  test('connectionStatus accepts all ConnectionState values', () => {
    const states: ConnectionState[] = ['online', 'offline', 'reconnecting'];
    for (const state of states) {
      const metrics: Pick<SyncHealthMetrics, 'connectionStatus'> = {
        connectionStatus: state,
      };
      expect(metrics.connectionStatus).toBe(state);
    }
  });

  test('PendingEventSummary has correct shape', () => {
    const summary: PendingEventSummary = { total: 0, byStream: {} };
    expect(summary.total).toBe(0);
    expect(summary.byStream).toEqual({});
  });

  test('LaneLagMetrics supports undefined values', () => {
    const lag: LaneLagMetrics = {
      localCheckpoint: undefined,
      upstreamHead: undefined,
      estimatedLag: undefined,
    };
    expect(lag.localCheckpoint).toBeUndefined();
    expect(lag.upstreamHead).toBeUndefined();
    expect(lag.estimatedLag).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// SyncAlert — discriminated union
// ---------------------------------------------------------------------------

describe('SyncAlert', () => {
  test('narrows correctly via type discriminant', () => {
    const alerts: SyncAlert[] = [
      { type: 'connection_changed', from: 'online', to: 'offline', timestamp: '2026-01-01T00:00:00Z' },
      { type: 'queue_depth_threshold', depth: 150, threshold: 100, timestamp: '2026-01-01T00:00:00Z' },
      { type: 'sync_lag_threshold', lane: 'events', lag: 60_000, threshold: 30_000, timestamp: '2026-01-01T00:00:00Z' },
      { type: 'pending_event_threshold', count: 75, threshold: 50, timestamp: '2026-01-01T00:00:00Z' },
    ];

    for (const alert of alerts) {
      switch (alert.type) {
        case 'connection_changed': {
          const _narrowed: ConnectionChangedAlert = alert;
          expect(_narrowed.from).toBe('online');
          expect(_narrowed.to).toBe('offline');
          break;
        }
        case 'queue_depth_threshold': {
          const _narrowed: QueueDepthThresholdAlert = alert;
          expect(_narrowed.depth).toBe(150);
          break;
        }
        case 'sync_lag_threshold': {
          const _narrowed: SyncLagThresholdAlert = alert;
          expect(_narrowed.lane).toBe('events');
          expect(_narrowed.lag).toBe(60_000);
          break;
        }
        case 'pending_event_threshold': {
          const _narrowed: PendingEventThresholdAlert = alert;
          expect(_narrowed.count).toBe(75);
          break;
        }
      }
    }
  });

  // Compile-time: each variant extends SyncAlert
  type _CheckConnection = AssertExtends<ConnectionChangedAlert, SyncAlert>;
  type _CheckQueue = AssertExtends<QueueDepthThresholdAlert, SyncAlert>;
  type _CheckLag = AssertExtends<SyncLagThresholdAlert, SyncAlert>;
  type _CheckPending = AssertExtends<PendingEventThresholdAlert, SyncAlert>;
});

// ---------------------------------------------------------------------------
// IMetricSink — implementability
// ---------------------------------------------------------------------------

describe('IMetricSink', () => {
  test('mock implementation satisfies the interface', () => {
    const emitted: SyncHealthMetrics[] = [];
    const emittedAlerts: SyncAlert[] = [];

    const sink: IMetricSink = {
      emit(metrics: SyncHealthMetrics): void {
        emitted.push(metrics);
      },
      emitAlert(alert: SyncAlert): void {
        emittedAlerts.push(alert);
      },
    };

    expect(emitted).toHaveLength(0);
    expect(emittedAlerts).toHaveLength(0);

    // Verify the sink can be called without error
    sink.emit(makeMetrics());
    expect(emitted).toHaveLength(1);

    sink.emitAlert({
      type: 'queue_depth_threshold',
      depth: 200,
      threshold: 100,
      timestamp: '2026-01-01T00:00:00Z',
    });
    expect(emittedAlerts).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// defaultThresholds
// ---------------------------------------------------------------------------

describe('defaultThresholds', () => {
  test('returns a valid threshold set with positive values', () => {
    const t = defaultThresholds();

    expect(t.queueDepthWarning).toBeGreaterThan(0);
    expect(t.queueDepthCritical).toBeGreaterThan(t.queueDepthWarning);
    expect(t.syncLagWarningMs).toBeGreaterThan(0);
    expect(t.syncLagCriticalMs).toBeGreaterThan(t.syncLagWarningMs);
    expect(t.pendingEventWarning).toBeGreaterThan(0);
    expect(t.pendingEventCritical).toBeGreaterThan(t.pendingEventWarning);
  });
});

// ---------------------------------------------------------------------------
// checkThresholds
// ---------------------------------------------------------------------------

describe('checkThresholds', () => {
  const thresholds: SyncHealthThresholds = {
    queueDepthWarning: 100,
    queueDepthCritical: 500,
    syncLagWarningMs: 30_000,
    syncLagCriticalMs: 120_000,
    pendingEventWarning: 50,
    pendingEventCritical: 200,
  };

  test('produces no alerts when all metrics are within limits', () => {
    const metrics = makeMetrics({
      commandQueueDepth: 10,
      pendingEventCount: { total: 5, byStream: {} },
    });

    const alerts = checkThresholds(metrics, thresholds);
    expect(alerts).toHaveLength(0);
  });

  test('produces queue_depth_threshold alert at warning level', () => {
    const metrics = makeMetrics({ commandQueueDepth: 150 });
    const alerts = checkThresholds(metrics, thresholds);

    const queueAlert = alerts.find((a) => a.type === 'queue_depth_threshold');
    expect(queueAlert).toBeDefined();
    expect(queueAlert!.type).toBe('queue_depth_threshold');
    if (queueAlert!.type === 'queue_depth_threshold') {
      expect(queueAlert!.depth).toBe(150);
      expect(queueAlert!.threshold).toBe(100);
    }
  });

  test('produces queue_depth_threshold alert at critical level', () => {
    const metrics = makeMetrics({ commandQueueDepth: 600 });
    const alerts = checkThresholds(metrics, thresholds);

    const queueAlerts = alerts.filter((a) => a.type === 'queue_depth_threshold');
    // Only critical alert, not both
    expect(queueAlerts).toHaveLength(1);
    if (queueAlerts[0].type === 'queue_depth_threshold') {
      expect(queueAlerts[0].threshold).toBe(500);
    }
  });

  test('produces pending_event_threshold alert', () => {
    const metrics = makeMetrics({
      pendingEventCount: { total: 75, byStream: { 'stream-1': 75 } },
    });
    const alerts = checkThresholds(metrics, thresholds);

    const pendingAlert = alerts.find((a) => a.type === 'pending_event_threshold');
    expect(pendingAlert).toBeDefined();
    if (pendingAlert!.type === 'pending_event_threshold') {
      expect(pendingAlert!.count).toBe(75);
      expect(pendingAlert!.threshold).toBe(50);
    }
  });

  test('produces sync_lag_threshold alert for lagging lane', () => {
    const metrics = makeMetrics({
      perLaneSyncLag: {
        events: { localCheckpoint: 'cp-1', upstreamHead: 'head-1', estimatedLag: 60_000 },
        projections: { localCheckpoint: undefined, upstreamHead: undefined, estimatedLag: undefined },
        masterData: { localCheckpoint: undefined, upstreamHead: undefined, estimatedLag: undefined },
        configuration: { localCheckpoint: undefined, upstreamHead: undefined, estimatedLag: undefined },
      },
    });
    const alerts = checkThresholds(metrics, thresholds);

    const lagAlert = alerts.find((a) => a.type === 'sync_lag_threshold');
    expect(lagAlert).toBeDefined();
    if (lagAlert!.type === 'sync_lag_threshold') {
      expect(lagAlert!.lane).toBe('events');
      expect(lagAlert!.lag).toBe(60_000);
      expect(lagAlert!.threshold).toBe(30_000);
    }
  });

  test('skips sync_lag_threshold when estimatedLag is undefined', () => {
    const metrics = makeMetrics(); // all lag undefined by default
    const alerts = checkThresholds(metrics, thresholds);

    const lagAlerts = alerts.filter((a) => a.type === 'sync_lag_threshold');
    expect(lagAlerts).toHaveLength(0);
  });

  test('produces multiple alerts when multiple thresholds exceeded', () => {
    const metrics = makeMetrics({
      commandQueueDepth: 200,
      pendingEventCount: { total: 300, byStream: {} },
      perLaneSyncLag: {
        events: { localCheckpoint: 'cp-1', upstreamHead: 'head-1', estimatedLag: 150_000 },
        projections: { localCheckpoint: undefined, upstreamHead: undefined, estimatedLag: 45_000 },
        masterData: { localCheckpoint: undefined, upstreamHead: undefined, estimatedLag: undefined },
        configuration: { localCheckpoint: undefined, upstreamHead: undefined, estimatedLag: undefined },
      },
    });
    const alerts = checkThresholds(metrics, thresholds);

    const types = alerts.map((a) => a.type);
    expect(types).toContain('queue_depth_threshold');
    expect(types).toContain('pending_event_threshold');
    expect(types).toContain('sync_lag_threshold');
    // events lane critical + projections lane warning = 2 lag alerts
    expect(alerts.filter((a) => a.type === 'sync_lag_threshold')).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// captureHealthSnapshot
// ---------------------------------------------------------------------------

describe('captureHealthSnapshot', () => {
  test('gathers data from all dependencies', async () => {
    const mockConnectionMonitor: IConnectionMonitor = {
      getState: () => 'online',
      onStateChange: () => () => {},
    };

    const mockCommandQueue: ICommandQueue = {
      enqueue: async () => {},
      peekBatch: async () => [],
      ackBatch: async () => {},
      depth: async () => 7,
    };

    const checkpoints = new Map<SyncLane, Checkpoint>();
    checkpoints.set('events', {
      lane: 'events',
      position: 'cursor-42',
      savedAt: '2026-01-01T00:00:00Z',
    });

    const mockCheckpointStore: ICheckpointStore = {
      getCheckpoint: async (lane: SyncLane) => checkpoints.get(lane),
      saveCheckpoint: async () => {},
    };

    const deps: HealthSnapshotDependencies = {
      connectionMonitor: mockConnectionMonitor,
      commandQueue: mockCommandQueue,
      checkpointStore: mockCheckpointStore,
      nodeId: 'test-node-1',
    };

    const snapshot = await captureHealthSnapshot(deps);

    expect(snapshot.connectionStatus).toBe('online');
    expect(snapshot.commandQueueDepth).toBe(7);
    expect(snapshot.nodeId).toBe('test-node-1');
    expect(snapshot.capturedAt).toBeDefined();

    // Pending events default to zero (TODO adapter not yet available)
    expect(snapshot.pendingEventCount.total).toBe(0);
    expect(snapshot.pendingEventCount.byStream).toEqual({});

    // Events lane has a checkpoint
    expect(snapshot.perLaneSyncLag.events.localCheckpoint).toBe('cursor-42');
    expect(snapshot.lastSyncTimestamp.events).toBe('2026-01-01T00:00:00Z');

    // Upstream head not yet available (TODO)
    expect(snapshot.perLaneSyncLag.events.upstreamHead).toBeUndefined();
    expect(snapshot.perLaneSyncLag.events.estimatedLag).toBeUndefined();

    // Lanes without checkpoints
    expect(snapshot.perLaneSyncLag.projections.localCheckpoint).toBeUndefined();
    expect(snapshot.lastSyncTimestamp.projections).toBeUndefined();

    // All four lanes present
    expect(Object.keys(snapshot.perLaneSyncLag)).toHaveLength(4);
    expect(Object.keys(snapshot.lastSyncTimestamp)).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMetrics(overrides?: Partial<SyncHealthMetrics>): SyncHealthMetrics {
  return {
    connectionStatus: 'online',
    commandQueueDepth: 0,
    pendingEventCount: { total: 0, byStream: {} },
    perLaneSyncLag: {
      events: { localCheckpoint: undefined, upstreamHead: undefined, estimatedLag: undefined },
      projections: { localCheckpoint: undefined, upstreamHead: undefined, estimatedLag: undefined },
      masterData: { localCheckpoint: undefined, upstreamHead: undefined, estimatedLag: undefined },
      configuration: { localCheckpoint: undefined, upstreamHead: undefined, estimatedLag: undefined },
    },
    lastSyncTimestamp: {
      events: undefined,
      projections: undefined,
      masterData: undefined,
      configuration: undefined,
    },
    nodeId: 'test-node',
    capturedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}
