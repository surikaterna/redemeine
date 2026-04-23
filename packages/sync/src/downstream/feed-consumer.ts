// ---------------------------------------------------------------------------
// Feed Consumer — Event Stream Lane Consumption
// ---------------------------------------------------------------------------

import type { ICheckpointStore, Checkpoint } from '../store/checkpoint-store';
import type {
  IReconciliationEventStoreAdapter,
  UpstreamSnapshot,
  SyncEvent,
} from '../reconciliation/event-store-adapter';
import type { IReconciliationService } from '../reconciliation/reconciliation-service';
import type { EventStreamEnvelope, DownstreamEvent } from './event-stream-envelope';

// ---------------------------------------------------------------------------
// Listener callback
// ---------------------------------------------------------------------------

/**
 * Callback invoked after each envelope is processed.
 * Useful for observability, logging, or triggering side effects
 * on lifecycle signals.
 */
export type FeedEnvelopeListener = (
  envelope: EventStreamEnvelope,
  result: EnvelopeProcessResult,
) => void;

// ---------------------------------------------------------------------------
// Options and result types
// ---------------------------------------------------------------------------

/** Options for constructing a feed consumer. */
export interface FeedConsumerOptions {
  /** Adapter for event store operations needed by reconciliation. */
  readonly eventStoreAdapter: IReconciliationEventStoreAdapter;

  /** Store adapter for persisting per-lane checkpoints. */
  readonly checkpointStore: ICheckpointStore;

  /** Service for reconciling authoritative events against local. */
  readonly reconciliationService: IReconciliationService;

  /** Identifier of the local downstream node. */
  readonly nodeId: string;

  /** Optional listener invoked after each envelope is processed. */
  readonly onEnvelope?: FeedEnvelopeListener;
}

/** Result of processing a single envelope. */
export interface EnvelopeProcessResult {
  readonly envelopeType: EventStreamEnvelope['type'];
  readonly success: boolean;
  readonly error?: string;
}

/** Aggregate result of consuming an entire feed. */
export interface ConsumeResult {
  /** Total envelopes processed successfully. */
  readonly processed: number;

  /** Number of snapshot envelopes imported. */
  readonly snapshots: number;

  /** Number of event batches reconciled. */
  readonly reconciled: number;

  /** Number of envelopes that failed processing. */
  readonly errors: number;
}

// ---------------------------------------------------------------------------
// Consumer interface
// ---------------------------------------------------------------------------

/** Consumer for the event stream lane feed. */
export interface EventStreamConsumer {
  /**
   * Consumes all envelopes from the feed, processing each one
   * and saving a checkpoint after every successful envelope.
   * Errors are captured per-envelope without aborting the feed.
   */
  consume(feed: AsyncIterable<EventStreamEnvelope>): Promise<ConsumeResult>;

  /**
   * Returns the current checkpoint position for the event stream lane,
   * or `undefined` if no checkpoint has been saved yet.
   */
  getCheckpoint(): Promise<string | undefined>;
}

// ---------------------------------------------------------------------------
// Processing helpers
// ---------------------------------------------------------------------------

/**
 * Converts a {@link DownstreamEvent} to a kernel {@link Event}
 * with metadata.command.id for reconciliation.
 */
function toAuthoritative(event: DownstreamEvent): SyncEvent {
  return {
    type: event.type,
    payload: event.payload,
    id: event.eventId,
    metadata: {
      command: { id: event.commandId },
    },
  };
}

/**
 * Processes a single snapshot envelope by importing it into the event store.
 */
async function processSnapshot(
  envelope: Extract<EventStreamEnvelope, { type: 'snapshot' }>,
  eventStoreAdapter: IReconciliationEventStoreAdapter,
): Promise<EnvelopeProcessResult> {
  const snapshot: UpstreamSnapshot = {
    streamId: envelope.streamId,
    version: envelope.version,
    state: envelope.state,
    snapshotAt: envelope.snapshotAt,
  };
  await eventStoreAdapter.importSnapshot(snapshot);
  return { envelopeType: 'snapshot', success: true };
}

/**
 * Processes an events envelope by reconciling each command group
 * against local events via the reconciliation service.
 */
async function processEvents(
  envelope: Extract<EventStreamEnvelope, { type: 'events' }>,
  reconciliationService: IReconciliationService,
): Promise<EnvelopeProcessResult> {
  // Group events by commandId for batch reconciliation
  const byCommand = new Map<string, DownstreamEvent[]>();

  for (const event of envelope.events) {
    const group = byCommand.get(event.commandId);
    if (group) {
      group.push(event);
    } else {
      byCommand.set(event.commandId, [event]);
    }
  }

  for (const [commandId, events] of byCommand) {
    await reconciliationService.reconcile(
      commandId,
      envelope.streamId,
      events.map(toAuthoritative),
    );
  }

  return { envelopeType: 'events', success: true };
}

/**
 * Processes a lifecycle signal envelope (stream_added / stream_removed).
 * No store mutations — the listener callback handles side effects.
 */
function processLifecycleSignal(
  envelope: Extract<EventStreamEnvelope, { type: 'stream_added' }> |
    Extract<EventStreamEnvelope, { type: 'stream_removed' }>,
): EnvelopeProcessResult {
  return { envelopeType: envelope.type, success: true };
}

// ---------------------------------------------------------------------------
// Checkpoint persistence
// ---------------------------------------------------------------------------

/**
 * Saves a checkpoint for the events lane after processing an envelope.
 * Uses a monotonically-increasing counter encoded as a string.
 */
async function saveCheckpointAfterEnvelope(
  checkpointStore: ICheckpointStore,
  position: string,
): Promise<void> {
  const checkpoint: Checkpoint = {
    lane: 'events',
    position,
    savedAt: new Date().toISOString(),
  };
  await checkpointStore.saveCheckpoint('events', checkpoint);
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates an {@link EventStreamConsumer} that processes event stream
 * feed envelopes, reconciles authoritative events with local, and
 * persists checkpoints after each processed envelope for crash safety.
 */
export function createEventStreamConsumer(
  options: FeedConsumerOptions,
): EventStreamConsumer {
  const {
    eventStoreAdapter,
    checkpointStore,
    reconciliationService,
    onEnvelope,
  } = options;

  let envelopeCounter = 0;

  return {
    async consume(feed: AsyncIterable<EventStreamEnvelope>): Promise<ConsumeResult> {
      let processed = 0;
      let snapshots = 0;
      let reconciled = 0;
      let errors = 0;

      for await (const envelope of feed) {
        let result: EnvelopeProcessResult;

        try {
          switch (envelope.type) {
            case 'snapshot':
              result = await processSnapshot(envelope, eventStoreAdapter);
              snapshots++;
              break;
            case 'events':
              result = await processEvents(envelope, reconciliationService);
              reconciled++;
              break;
            case 'stream_added':
            case 'stream_removed':
              result = processLifecycleSignal(envelope);
              break;
          }

          processed++;
          envelopeCounter++;
          await saveCheckpointAfterEnvelope(
            checkpointStore,
            String(envelopeCounter),
          );
        } catch (error: unknown) {
          const reason = error instanceof Error ? error.message : String(error);
          result = { envelopeType: envelope.type, success: false, error: reason };
          errors++;
        }

        onEnvelope?.(envelope, result);
      }

      return { processed, snapshots, reconciled, errors };
    },

    async getCheckpoint(): Promise<string | undefined> {
      const checkpoint = await checkpointStore.getCheckpoint('events');
      return checkpoint?.position;
    },
  };
}
