// ---------------------------------------------------------------------------
// Supporting types
// ---------------------------------------------------------------------------

/** Metadata attached to every queued command for traceability. */
export interface CommandMetadata {
  /** Identifier of the node that enqueued the command. */
  readonly nodeId: string;

  /** Tenant partition key. */
  readonly tenant: string;

  /** ISO-8601 timestamp when the command was created. */
  readonly timestamp: string;

  /** Optional correlation ID for distributed tracing. */
  readonly correlationId?: string;

  /** Optional causation ID linking to the event/command that triggered this. */
  readonly causationId?: string;
}

/** A command entry stored in the durable FIFO queue. */
export interface QueuedCommand {
  /** Client-assigned command identifier (correlation key). */
  readonly commandId: string;

  /** Aggregate type this command targets. */
  readonly aggregateType: string;

  /** Aggregate instance identifier. */
  readonly aggregateId: string;

  /** Fully-qualified command type. */
  readonly commandType: string;

  /** Serialized command payload. */
  readonly payload: unknown;

  /** Traceability metadata. */
  readonly metadata: CommandMetadata;

  /** ISO-8601 timestamp when the command was enqueued. */
  readonly enqueuedAt: string;
}

// ---------------------------------------------------------------------------
// Queue contract
// ---------------------------------------------------------------------------

/**
 * Adapter contract for a durable, crash-safe FIFO command queue.
 *
 * Commands are enqueued locally and drained in batches for upstream
 * submission. The peek/ack pattern ensures at-least-once delivery:
 * commands remain visible until explicitly acknowledged.
 */
export interface ICommandQueue {
  /**
   * Appends a command to the tail of the queue.
   *
   * @param command — the command to enqueue.
   */
  enqueue(command: QueuedCommand): Promise<void>;

  /**
   * Returns up to {@link size} commands from the head of the queue
   * without removing them. Subsequent calls return the same batch
   * until {@link ackBatch} is called.
   *
   * @param size — maximum number of commands to return.
   */
  peekBatch(size: number): Promise<ReadonlyArray<QueuedCommand>>;

  /**
   * Acknowledges successful processing of the specified commands,
   * removing them from the queue.
   *
   * @param commandIds — IDs of the commands to acknowledge.
   */
  ackBatch(commandIds: ReadonlyArray<string>): Promise<void>;

  /**
   * Returns the current number of commands in the queue.
   */
  depth(): Promise<number>;
}
