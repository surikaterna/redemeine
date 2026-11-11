import { ClientSession, Collection, Db, MongoClient, ObjectId, type WithTransactionCallback } from 'mongodb';
import { MongoProjectionStore } from '@redemeine/projection-runtime-store-mongodb';
import { parseConfig } from '../../src/config';
import { createMongoClient, type MongoClientFactory } from '../../src/infrastructure/mongo';
import { externalEnvironment } from '../fixtures';
import { modelCommit } from '../../src/reference/scenario';
import type { ProjectionSourceCommit } from '@redemeine/projection-runtime-core';

export function externalConfig() {
  const config = parseConfig(externalEnvironment, []);
  if (config.mode !== 'external') throw new Error('expected_external');
  return config;
}

export function mongoClientFixture() {
  const config = externalConfig();
  const instances: MongoClient[] = [];
  const connect = jest.spyOn(MongoClient.prototype, 'connect').mockImplementation(async function(this: MongoClient) { return this; });
  const close = jest.spyOn(MongoClient.prototype, 'close').mockResolvedValue();
  const ping = jest.spyOn(Db.prototype, 'command').mockResolvedValue({ ok: 1 });
  const seed = new MongoClient(config.external.mongodbUri);
  const indexes = seed.db().collection('commits').listIndexes();
  const indexRows = jest.spyOn(indexes, 'toArray').mockResolvedValue([{ name: 'stream_sequence', key: { streamId: 1, commitSequence: 1 }, unique: true }]);
  jest.spyOn(Collection.prototype, 'listIndexes').mockReturnValue(indexes);
  const transaction = jest.spyOn(ClientSession.prototype, 'withTransaction').mockImplementation(
    async function<T>(this: ClientSession, callback: WithTransactionCallback<T>): Promise<T> { return callback(this); });
  const endSession = jest.spyOn(ClientSession.prototype, 'endSession').mockResolvedValue();
  const findOne = jest.spyOn(Collection.prototype, 'findOne').mockResolvedValue(null);
  const createIndex = jest.spyOn(Collection.prototype, 'createIndex').mockRejectedValue(new Error('unexpected_ddl'));
  const update = jest.spyOn(Collection.prototype, 'updateOne').mockRejectedValue(new Error('unexpected_write'));
  const initialize = jest.spyOn(MongoProjectionStore.prototype, 'initializeProjectionSourceCommitStore');
  const collections = jest.spyOn(Db.prototype, 'collection');
  const factory: MongoClientFactory = jest.fn((uri, options) => {
    const client = createMongoClient(uri, options); instances.push(client); return client;
  });
  return { config, factory, instances, connect, close, ping, indexRows, transaction, endSession, findOne, createIndex, update, initialize, collections, seed };
}

export function mongoRangeFixture(seed: MongoClient, commit: ProjectionSourceCommit = modelCommit(42)) {
  const row = { _id: new ObjectId(), id: commit.commitId, streamId: commit.streamId, partitionId: 'partition',
    commitSequence: commit.commitSequence, events: commit.events.map((event) => ({ id: event.eventId, version: event.streamVersion,
      aggregateType: event.aggregateType, aggregateId: event.aggregateId, type: event.type, payload: event.payload, timestamp: event.timestamp })) };
  const cursor = seed.db().collection('commits').find();
  const sort = jest.spyOn(cursor, 'sort');
  const hint = jest.spyOn(cursor, 'hint');
  const limit = jest.spyOn(cursor, 'limit');
  const batchSize = jest.spyOn(cursor, 'batchSize');
  jest.spyOn(cursor, Symbol.asyncIterator).mockImplementation(async function* () { yield row; });
  const find = jest.spyOn(Collection.prototype, 'find').mockReturnValue(cursor);
  return { find, sort, hint, limit, batchSize, row };
}
