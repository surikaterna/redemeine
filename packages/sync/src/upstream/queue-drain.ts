// ---------------------------------------------------------------------------
// Queue drain orchestration — drains the local command queue upstream
// ---------------------------------------------------------------------------

import type { ICommandQueue, QueuedCommand } from '../store/command-queue';
import type {
  UpstreamCommandEnvelope,
  UpstreamCommandMetadata,
  UpstreamBatchRequest,
} from './command-envelope';
import type { UpstreamBatchResult, UpstreamCommandResult } from './batch-result';
import type { UpstreamSyncService } from './sync-service-contract';
import type { IConnectionMonitor, Unsubscribe } from './connection-state';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Summary of a single drain cycle. */
export interface DrainResult {
  /** Number of commands successfully drained (accepted + duplicate). */
  readonly drained: number;

  /** Number of commands that were rejected by upstream. */
  readonly failed: number;

  /** Number of commands still remaining in the queue. */
  readonly remaining: number;
}

/** Callback invoked after each drain cycle completes. */
export type DrainResultListener = (result: DrainResult) => void;

/** Configuration for the queue drain orchestrator. */
export interface QueueDrainOptions {
  /** The durable FIFO command queue to drain from. */
  readonly queue: ICommandQueue;

  /** scomp service for submitting commands upstream. */
  readonly syncService: UpstreamSyncService;

  /** Monitor for upstream connection state. */
  readonly connectionMonitor: IConnectionMonitor;

  /** Maximum number of commands per batch. Defaults to 25. */
  readonly batchSize?: number;

  /** Identifier of this node. */
  readonly nodeId: string;

  /** Optional callback invoked after each drain cycle. */
  readonly onDrainResult?: DrainResultListener;
}

/** Controls the queue drain lifecycle. */
export interface QueueDrain {
  /** Starts listening for connection state changes and auto-draining. */
  start(): void;

  /** Stops the drain loop and unsubscribes from connection state. */
  stop(): void;

  /** Runs a single drain cycle. Safe to call while stopped. */
  drainOnce(): Promise<DrainResult>;

  /** Returns whether the drain loop is actively listening. */
  isRunning(): boolean;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const DEFAULT_BATCH_SIZE = 25;

/** Maps a queued command to an upstream command envelope. */
const toEnvelope = (cmd: QueuedCommand): UpstreamCommandEnvelope => {
  const metadata: UpstreamCommandMetadata = {
    nodeId: cmd.metadata.nodeId,
    tenant: cmd.metadata.tenant,
    timestamp: cmd.metadata.timestamp,
    correlationId: cmd.metadata.correlationId,
    causationId: cmd.metadata.causationId,
  };

  return {
    commandId: cmd.commandId,
    aggregateType: cmd.aggregateType,
    aggregateId: cmd.aggregateId,
    commandType: cmd.commandType,
    payload: cmd.payload,
    metadata,
  };
};

/** Generates a simple unique batch ID. */
const newBatchId = (): string =>
  `batch-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

/** Partitions command results into acked and rejected sets. */
const partitionResults = (
  results: ReadonlyArray<UpstreamCommandResult>,
): { ackedIds: string[]; rejectedCount: number } => {
  const ackedIds: string[] = [];
  let rejectedCount = 0;

  for (const result of results) {
    switch (result.status) {
      case 'accepted':
      case 'duplicate':
        ackedIds.push(result.commandId);
        break;
      case 'rejected':
        ackedIds.push(result.commandId);
        rejectedCount++;
        break;
    }
  }

  return { ackedIds, rejectedCount };
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a {@link QueueDrain} that drains the local command queue by
 * submitting batches to the upstream sync service.
 *
 * The queue is the sole source of truth — no in-memory state is kept
 * beyond the `running` flag. If the process crashes mid-drain, unacked
 * commands remain in the queue for the next cycle.
 */
export const createQueueDrain = (options: QueueDrainOptions): QueueDrain => {
  const {
    queue,
    syncService,
    connectionMonitor,
    batchSize = DEFAULT_BATCH_SIZE,
    nodeId,
    onDrainResult,
  } = options;

  let running = false;
  let unsubscribe: Unsubscribe | undefined;

  const drainOnce = async (): Promise<DrainResult> => {
    const state = connectionMonitor.getState();

    if (state !== 'online') {
      const remaining = await queue.depth();
      return { drained: 0, failed: 0, remaining };
    }

    const batch = await queue.peekBatch(batchSize);

    if (batch.length === 0) {
      return { drained: 0, failed: 0, remaining: 0 };
    }

    const envelopes = batch.map(toEnvelope);

    const request: UpstreamBatchRequest = {
      batchId: newBatchId(),
      nodeId,
      sentAt: new Date().toISOString(),
      commands: envelopes,
    };

    const response: UpstreamBatchResult = await syncService.submitCommands(request);

    const { ackedIds, rejectedCount } = partitionResults(response.results);

    if (ackedIds.length > 0) {
      await queue.ackBatch(ackedIds);
    }

    const remaining = await queue.depth();
    const drained = ackedIds.length - rejectedCount;

    const result: DrainResult = { drained, failed: rejectedCount, remaining };

    onDrainResult?.(result);

    return result;
  };

  const start = (): void => {
    if (running) return;
    running = true;

    unsubscribe = connectionMonitor.onStateChange((state) => {
      if (state === 'online') {
        // Fire-and-forget drain on reconnect — errors are swallowed
        // because the queue retains unacked commands for the next cycle.
        void drainOnce();
      }
    });
  };

  const stop = (): void => {
    if (!running) return;
    running = false;
    unsubscribe?.();
    unsubscribe = undefined;
  };

  const isRunning = (): boolean => running;

  return { start, stop, drainOnce, isRunning };
};
