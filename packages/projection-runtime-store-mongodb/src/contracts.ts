/**
 * Local copy of the current projection runtime store contracts.
 *
 * This keeps the Mongo adapter package buildable in isolation while the
 * runtime-core package split is still in progress.
 */
export interface Checkpoint {
  sequence: number;
  timestamp?: string;
}

export interface IProjectionStore<TState = unknown> {
  load(documentId: string): Promise<TState | null>;
  save(documentId: string, state: TState, checkpoint: Checkpoint): Promise<void>;
  getCheckpoint?(key: string): Promise<Checkpoint | null>;
  delete?(documentId: string): Promise<void>;
}

export interface IProjectionLinkStore {
  addLink(aggregateType: string, aggregateId: string, targetDocId: string): Promise<void> | void;
  resolveTarget(aggregateType: string, aggregateId: string): Promise<string | null> | string | null;
  removeLinksForTarget?(targetDocId: string): Promise<void> | void;
}
