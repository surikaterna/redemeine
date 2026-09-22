import type { ProjectionQueueRegistryManifest } from '@redemeine/projection-runtime-core';
import type { Collection, Document } from 'mongodb';
import type { MongoProjectionTransportStore } from '../mongoTransportStore';
import type { ProjectionMigrationRegistryPort, ProjectionMigrationState, ProjectionMigrationStatePort } from './types';

interface MigrationStateDocument extends Document, ProjectionMigrationState {
  readonly _id: string;
}

export class MongoProjectionMigrationStatePort implements ProjectionMigrationStatePort {
  constructor(private readonly collection: Collection<MigrationStateDocument>) {}

  async initialize(): Promise<void> {
    await this.collection.createIndex({ migrationId: 1 }, { name: 'projection_migration_id_unique', unique: true });
  }

  async load(migrationId: string): Promise<ProjectionMigrationState | null> {
    const document = await this.collection.findOne({ _id: migrationId });
    if (!document) return null;
    const { _id: _ignored, ...state } = document;
    return state;
  }

  async compareAndSet(expectedRevision: number | null, state: ProjectionMigrationState): Promise<boolean> {
    if (expectedRevision === null) {
      try {
        const result = await this.collection.updateOne({ _id: state.migrationId }, { $setOnInsert: { _id: state.migrationId, ...state } }, { upsert: true });
        return result.upsertedCount === 1;
      } catch (error) {
        if (typeof error === 'object' && error !== null && 'code' in error && error.code === 11000) return false;
        throw error;
      }
    }
    const result = await this.collection.replaceOne({ _id: state.migrationId, revision: expectedRevision }, { _id: state.migrationId, ...state });
    return result.modifiedCount === 1;
  }
}

export class MongoProjectionMigrationRegistryPort implements ProjectionMigrationRegistryPort {
  constructor(private readonly transport: MongoProjectionTransportStore) {}

  async adopt(manifest: ProjectionQueueRegistryManifest): Promise<'bound' | 'matches' | 'conflict'> {
    return (await this.transport.bindImmutableManifest(manifest)).status;
  }
}
