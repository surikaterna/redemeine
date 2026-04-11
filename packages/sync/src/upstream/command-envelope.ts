// ---------------------------------------------------------------------------
// Upstream command envelope — types for commands submitted to upstream nodes
// ---------------------------------------------------------------------------

/** Traceability metadata attached to every upstream command submission. */
export interface UpstreamCommandMetadata {
  /** Identifier of the node submitting the command. */
  readonly nodeId: string;

  /** Tenant partition key. */
  readonly tenant: string;

  /** ISO-8601 timestamp when the command was created. */
  readonly timestamp: string;

  /** Optional correlation ID for distributed tracing. */
  readonly correlationId?: string;

  /** Optional causation ID linking to the triggering event or command. */
  readonly causationId?: string;
}

/** A single command envelope for upstream submission. */
export interface UpstreamCommandEnvelope {
  /** Client-assigned command identifier used for upstream deduplication. */
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
  readonly metadata: UpstreamCommandMetadata;
}

/** A batch of command envelopes submitted to the upstream node. */
export interface UpstreamBatchRequest {
  /** Unique identifier for this batch submission. */
  readonly batchId: string;

  /** Identifier of the node submitting the batch. */
  readonly nodeId: string;

  /** ISO-8601 timestamp when the batch was sent. */
  readonly sentAt: string;

  /** The commands included in this batch. */
  readonly commands: ReadonlyArray<UpstreamCommandEnvelope>;
}
