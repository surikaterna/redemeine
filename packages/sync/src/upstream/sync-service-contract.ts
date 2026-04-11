// ---------------------------------------------------------------------------
// Upstream sync service contract — scomp service interface
// ---------------------------------------------------------------------------

import type { UpstreamBatchRequest } from './command-envelope';
import type { UpstreamBatchResult } from './batch-result';

/**
 * Service contract for upstream command submission.
 *
 * This interface is designed to be implemented as a scomp `request` operation.
 * The downstream node calls {@link submitCommands} to send a batch of queued
 * commands to its upstream node. The upstream responds with per-command
 * results indicating whether each command was accepted, rejected, or
 * detected as a duplicate.
 *
 * Transport is pluggable — scomp handles serialization and delivery.
 * Consumers provide a concrete implementation backed by their chosen
 * transport layer.
 *
 * @example
 * ```ts
 * // scomp service registration (upstream side)
 * scomp.register('sync.submitCommands', handler);
 *
 * // scomp client call (downstream side)
 * const result = await syncService.submitCommands(batch);
 * ```
 */
export interface UpstreamSyncService {
  /**
   * Submits a batch of commands to the upstream node.
   *
   * @param request — the batch request containing one or more command envelopes.
   * @returns per-command results for the submitted batch.
   */
  submitCommands(request: UpstreamBatchRequest): Promise<UpstreamBatchResult>;
}
