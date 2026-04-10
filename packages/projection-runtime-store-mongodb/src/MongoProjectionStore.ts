import type {
  AnyBulkWriteOperation,
  ClientSession,
  MongoServerError,
  TransactionOptions,
  UpdateOptions,
  BulkWriteOptions,
  FindOptions
} from 'mongodb';
import type {
  Checkpoint,
  IProjectionStore,
  ProjectionStoreAtomicManyResult,
  ProjectionStoreCommitAtomicManyRequest,
  ProjectionStoreDocumentWrite
} from './contracts';
import {
  ProjectionStoreAtomicManyError,
  assertWritePrecondition,
  createInvalidRequestFailure,
  createStoreFailure,
  toWriteFailure
} from './storeFailures';
import type {
  MongoProjectionStoreOptions,
  ProjectionDocumentRecord
} from './types';

const defaultNow = (): string => new Date().toISOString();

const TRANSACTION_NOT_SUPPORTED_CODES = new Set<number>([20, 303, 263]);

const isMongoTransactionError = (error: unknown): error is Error => {
  if (!(error instanceof Error)) {
    return false;
  }

  const name = error.name;
  return name === 'MongoServerError' || name === 'MongoTransactionError' || name === 'MongoCompatibilityError';
};

const isTransactionNotSupportedError = (error: unknown): boolean => {
  if (!isMongoTransactionError(error)) {
    return false;
  }

  const maybeServerError = error as MongoServerError;
  if (typeof maybeServerError.code === 'number' && TRANSACTION_NOT_SUPPORTED_CODES.has(maybeServerError.code)) {
    return true;
  }

  const message = error.message.toLowerCase();
  return (
    message.includes('transaction numbers are only allowed') ||
    message.includes('replica set') ||
    message.includes('does not support transactions') ||
    message.includes('transaction is not supported')
  );
};

const withSession = <T extends object>(options: T, session: ClientSession): T & { session: ClientSession } => ({
  ...options,
  session
});

type TransactionExecutor = <T>(work: (session: ClientSession) => Promise<T>) => Promise<T>;

/**
 * Mongo-backed projection store adapter with transaction-backed atomicity.
 */
export class MongoProjectionStore<TState = unknown> implements IProjectionStore<TState> {
  private readonly now: () => string;

  constructor(private readonly options: MongoProjectionStoreOptions<TState>) {
    this.now = options.now ?? defaultNow;
  }

  async load(documentId: string): Promise<TState | null> {
    const row = await this.options.collection.findOne({ _id: documentId });
    return row ? row.state : null;
  }

  async save(documentId: string, state: TState, checkpoint: Checkpoint): Promise<void> {
    await this.saveWithSession(documentId, state, checkpoint);
  }

  async delete(documentId: string): Promise<void> {
    await this.options.collection.deleteOne({ _id: documentId });
  }

  async commitAtomic(write: {
    documents: Array<{ documentId: string; state: TState; checkpoint: Checkpoint }>;
    links: Array<{ aggregateType: string; aggregateId: string; targetDocId: string }>;
    cursorKey: string;
    cursor: Checkpoint;
    dedupe: { upserts: Array<{ key: string; checkpoint: Checkpoint }> };
  }): Promise<void> {
    const execute = this.createTransactionExecutor();

    await execute(async (session) => {
      await this.persistCommitAtomicWithBulkWrite(write, session);
    });
  }

  async commitAtomicMany(
    request: ProjectionStoreCommitAtomicManyRequest<TState>
  ): Promise<ProjectionStoreAtomicManyResult> {
    if (request.mode !== 'atomic-all') {
      const failure = createInvalidRequestFailure(`unsupported mode: ${request.mode}`);
      return {
        status: 'rejected',
        highestWatermark: null,
        failedAtIndex: 0,
        failure,
        reason: failure.message,
        committedCount: 0
      };
    }

    if (request.writes.length === 0) {
      const failure = createInvalidRequestFailure('no writes');
      return {
        status: 'rejected',
        highestWatermark: null,
        failedAtIndex: 0,
        failure,
        reason: failure.message,
        committedCount: 0
      };
    }

    const byLaneWatermark: Record<string, Checkpoint> = {};
    let highestWatermark: Checkpoint | null = null;
    let failedAtIndex = 0;

    const execute = this.createTransactionExecutor();

    try {
      await execute(async (session) => {
        for (let index = 0; index < request.writes.length; index += 1) {
          failedAtIndex = index;
          const write = request.writes[index];
          let laneWatermark: Checkpoint | null = null;
          const documentOps: Array<AnyBulkWriteOperation<ProjectionDocumentRecord<TState>>> = [];
          const stagedDocuments = new Map<string, ProjectionDocumentRecord<TState>>();

          for (const document of write.documents) {
            const staged = stagedDocuments.get(document.documentId);
            const current =
              staged ??
              (await this.options.collection.findOne(
                { _id: document.documentId },
                withSession({} as FindOptions<ProjectionDocumentRecord<TState>>, session)
              ));
            const nextState = this.resolveNextDocumentState(document, current);

            stagedDocuments.set(document.documentId, {
              _id: document.documentId,
              state: nextState,
              checkpoint: document.checkpoint,
              updatedAt: this.now()
            });

            documentOps.push({
              updateOne: {
                filter: { _id: document.documentId },
                update: {
                  $set: {
                    state: nextState,
                    checkpoint: document.checkpoint,
                    updatedAt: this.now()
                  }
                },
                upsert: true
              }
            });
            laneWatermark = this.chooseHigherWatermark(laneWatermark, document.checkpoint);
            highestWatermark = this.chooseHigherWatermark(highestWatermark, document.checkpoint);
          }

          if (documentOps.length > 0) {
            await this.options.collection.bulkWrite(
              documentOps,
              withSession<Pick<BulkWriteOptions, 'ordered'>>({ ordered: true }, session)
            );
          }

          if (write.dedupe.upserts.length > 0) {
            await this.options.dedupeCollection.bulkWrite(
              write.dedupe.upserts.map<AnyBulkWriteOperation<{ _id: string; checkpoint: Checkpoint; updatedAt: string }>>(
                (dedupe) => ({
                  updateOne: {
                    filter: { _id: dedupe.key },
                    update: {
                      $set: {
                        checkpoint: dedupe.checkpoint,
                        updatedAt: this.now()
                      }
                    },
                    upsert: true
                  }
                })
              ),
              withSession<Pick<BulkWriteOptions, 'ordered'>>({ ordered: true }, session)
            );

            for (const dedupe of write.dedupe.upserts) {
              laneWatermark = this.chooseHigherWatermark(laneWatermark, dedupe.checkpoint);
              highestWatermark = this.chooseHigherWatermark(highestWatermark, dedupe.checkpoint);
            }
          }

          if (laneWatermark) {
            byLaneWatermark[write.routingKeySource] = laneWatermark;
          }
        }
      });
    } catch (error) {
      const failure = toWriteFailure(error);
      return {
        status: 'rejected',
        highestWatermark: null,
        failedAtIndex,
        failure,
        reason: failure.message,
        committedCount: 0
      };
    }

    return {
      status: 'committed',
      highestWatermark: highestWatermark ?? { sequence: 0 },
      byLaneWatermark,
      committedCount: request.writes.length
    };
  }

  async resolveTarget(aggregateType: string, aggregateId: string): Promise<string | null> {
    const row = await this.options.linkCollection.findOne({ _id: `${aggregateType}:${aggregateId}` });
    return row ? row.targetDocId : null;
  }

  async getCheckpoint(key: string): Promise<Checkpoint | null> {
    const row = await this.options.collection.findOne({ _id: key });
    return row ? row.checkpoint : null;
  }

  async getDedupeCheckpoint(key: string): Promise<Checkpoint | null> {
    const row = await this.options.dedupeCollection.findOne({ _id: key });
    return row ? row.checkpoint : null;
  }

  private async persistCommitAtomicWithBulkWrite(
    write: {
      documents: Array<{ documentId: string; state: TState; checkpoint: Checkpoint }>;
      links: Array<{ aggregateType: string; aggregateId: string; targetDocId: string }>;
      cursorKey: string;
      cursor: Checkpoint;
      dedupe: { upserts: Array<{ key: string; checkpoint: Checkpoint }> };
    },
    session: ClientSession
  ): Promise<void> {
    const projectionOps: Array<AnyBulkWriteOperation<ProjectionDocumentRecord<TState>>> = [];

    for (const document of write.documents) {
      projectionOps.push({
        updateOne: {
          filter: { _id: document.documentId },
          update: {
            $set: {
              state: document.state,
              checkpoint: document.checkpoint,
              updatedAt: this.now()
            }
          },
          upsert: true
        }
      });
    }

    projectionOps.push({
      updateOne: {
        filter: { _id: write.cursorKey },
        update: {
          $set: {
            state: {} as TState,
            checkpoint: write.cursor,
            updatedAt: this.now()
          }
        },
        upsert: true
      }
    });

    if (projectionOps.length > 0) {
      await this.options.collection.bulkWrite(
        projectionOps,
        withSession<Pick<BulkWriteOptions, 'ordered'>>({ ordered: true }, session)
      );
    }

    if (write.links.length > 0) {
      await this.options.linkCollection.bulkWrite(
        write.links.map((link) => ({
          updateOne: {
            filter: { _id: `${link.aggregateType}:${link.aggregateId}` },
            update: {
              $setOnInsert: {
                aggregateType: link.aggregateType,
                aggregateId: link.aggregateId,
                targetDocId: link.targetDocId,
                createdAt: this.now()
              }
            },
            upsert: true
          }
        })),
        withSession<Pick<BulkWriteOptions, 'ordered'>>({ ordered: true }, session)
      );
    }

    if (write.dedupe.upserts.length > 0) {
      await this.options.dedupeCollection.bulkWrite(
        write.dedupe.upserts.map((dedupe) => ({
          updateOne: {
            filter: { _id: dedupe.key },
            update: {
              $set: {
                checkpoint: dedupe.checkpoint,
                updatedAt: this.now()
              }
            },
            upsert: true
          }
        })),
        withSession<Pick<BulkWriteOptions, 'ordered'>>({ ordered: true }, session)
      );
    }
  }

  private async saveWithSession(
    documentId: string,
    state: TState,
    checkpoint: Checkpoint,
    session?: ClientSession
  ): Promise<void> {
    const updateOptions: Pick<UpdateOptions, 'upsert' | 'session'> | undefined = session
      ? withSession<Pick<UpdateOptions, 'upsert'>>({ upsert: true }, session)
      : { upsert: true };

    await this.options.collection.updateOne(
      { _id: documentId },
      {
        $set: {
          state,
          checkpoint,
          updatedAt: this.now()
        }
      },
      updateOptions
    );
  }

  private createTransactionExecutor(): TransactionExecutor {
    return async <T>(work: (session: ClientSession) => Promise<T>): Promise<T> => {
      const session = this.options.mongoClient.startSession();

      try {
        const result = await session.withTransaction(
          async () => work(session),
          this.options.transactionOptions as TransactionOptions | undefined
        );
        return result as T;
      } catch (error) {
        if (isTransactionNotSupportedError(error)) {
          throw new ProjectionStoreAtomicManyError(
            createStoreFailure(
              'terminal',
              'transactions-not-supported',
              'MongoDB transactions are required for atomic projection store operations. Configure a replica set or sharded deployment with transactions enabled.'
            )
          );
        }

        throw error;
      } finally {
        await session.endSession();
      }
    };
  }

  private resolveNextDocumentState(
    write: ProjectionStoreDocumentWrite<TState>,
    current: ProjectionDocumentRecord<TState> | null
  ): TState {
    assertWritePrecondition(write.documentId, current?.checkpoint ?? null, write.precondition);

    if (write.mode === 'full') {
      return write.fullDocument;
    }

    const currentState = current?.state;
    const base =
      currentState && typeof currentState === 'object' && !Array.isArray(currentState)
        ? (currentState as Record<string, unknown>)
        : {};

    const nextState = {
      ...base,
      ...write.patch
    } as TState;

    return nextState;
  }

  private chooseHigherWatermark(current: Checkpoint | null, next: Checkpoint): Checkpoint {
    if (!current) {
      return this.cloneCheckpoint(next);
    }

    if (next.sequence > current.sequence) {
      return this.cloneCheckpoint(next);
    }

    if (next.sequence === current.sequence && next.timestamp && (!current.timestamp || next.timestamp > current.timestamp)) {
      return this.cloneCheckpoint(next);
    }

    return current;
  }

  private cloneCheckpoint(checkpoint: Checkpoint): Checkpoint {
    return {
      sequence: checkpoint.sequence,
      ...(checkpoint.timestamp ? { timestamp: checkpoint.timestamp } : {})
    };
  }
}
