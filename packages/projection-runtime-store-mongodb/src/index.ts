import {
  IProjectionStore,
  IProjectionLinkStore,
  Checkpoint
} from '@redemeine/projection-runtime-core';

/**
 * Scaffold-only MongoDB store implementation placeholder.
 *
 * This package is intentionally limited to type-level contracts in bead redemeine-tzx.
 * Concrete persistence behavior is implemented in follow-up bead redemeine-vs2.
 */
export class MongoProjectionStore<TState = unknown> implements IProjectionStore<TState> {
  async load(_documentId: string): Promise<TState | null> {
    throw new Error('MongoProjectionStore is scaffold-only and not implemented yet.');
  }

  async save(_documentId: string, _state: TState, _checkpoint: Checkpoint): Promise<void> {
    throw new Error('MongoProjectionStore is scaffold-only and not implemented yet.');
  }

  async getCheckpoint(_key: string): Promise<Checkpoint | null> {
    throw new Error('MongoProjectionStore is scaffold-only and not implemented yet.');
  }

  async delete(_documentId: string): Promise<void> {
    throw new Error('MongoProjectionStore is scaffold-only and not implemented yet.');
  }
}

export class MongoProjectionLinkStore implements IProjectionLinkStore {
  async addLink(_aggregateType: string, _aggregateId: string, _targetDocId: string): Promise<void> {
    throw new Error('MongoProjectionLinkStore is scaffold-only and not implemented yet.');
  }

  async resolveTarget(_aggregateType: string, _aggregateId: string): Promise<string | null> {
    throw new Error('MongoProjectionLinkStore is scaffold-only and not implemented yet.');
  }

  async removeLinksForTarget(_targetDocId: string): Promise<void> {
    throw new Error('MongoProjectionLinkStore is scaffold-only and not implemented yet.');
  }
}
