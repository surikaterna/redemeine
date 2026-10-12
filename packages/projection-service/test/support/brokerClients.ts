import { Collection, ObjectId } from 'mongodb';
import { isDeepStrictEqual } from 'node:util';
import type { ProjectionSourceCommit } from '@redemeine/projection-runtime-core';
import type { RabbitConnector } from '../../src/infrastructure/rabbit';
import { object } from '../../src/infrastructure/brokerSchema';
import { referenceScenario } from '../../src/reference/scenario';
import { mongoClientFixture, mongoRangeFixture } from './mongoClient';
import { ManagementFixture } from './brokerManagement';
import { FakeRabbitConnection, rawMessage } from './rabbitClient';

function matches(row: Record<string, unknown>, filter: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([key, value]) => {
    if (value && typeof value === 'object' && '$exists' in value) return (row[key] !== undefined) === value.$exists;
    return isDeepStrictEqual(row[key], value);
  });
}

function mongoRows(fixture: ReturnType<typeof mongoClientFixture>) {
  const rows = new Map<string, Record<string, unknown>>();
  const trace: string[] = [];
  const key = (collection: string, id: unknown) => JSON.stringify([collection, id]);
  fixture.findOne.mockImplementation(async function(this: Collection, filter) {
    const row = rows.get(key(this.collectionName, filter._id));
    return row ? JSON.parse(JSON.stringify(row)) : null;
  });
  jest.spyOn(Collection.prototype, 'insertOne').mockImplementation(async function(this: Collection, record) {
    const id = key(this.collectionName, record._id);
    if (rows.has(id)) throw new Error('duplicate');
    rows.set(id, { ...record }); trace.push('control:prepared');
    return { acknowledged: true, insertedId: new ObjectId() };
  });
  fixture.update.mockImplementation(async function(this: Collection, filter, update, options) {
    const id = key(this.collectionName, filter._id); const current = rows.get(id);
    const compatible = current ? matches(current, filter) : !!options?.upsert;
    if (!compatible) return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 0, upsertedId: null };
    const operation = object(update);
    const inserted = !current && operation.$setOnInsert ? object(operation.$setOnInsert) : {};
    const changes = operation.$set ? object(operation.$set) : {};
    rows.set(id, { _id: filter._id, ...current, ...inserted, ...changes });
    trace.push(this.collectionName.endsWith('_floors') ? `floor:${changes.coveredThrough ?? 'admit'}`
      : this.collectionName.endsWith('_documents') ? 'document' : 'metadata');
    return { acknowledged: true, matchedCount: current ? 1 : 0, modifiedCount: current ? 1 : 0,
      upsertedCount: current ? 0 : 1, upsertedId: null };
  });
  return { rows, trace };
}

export function brokerClients(commit: ProjectionSourceCommit = referenceScenario()[0] ?? (() => { throw new Error('missing_fixture'); })()) {
  const mongo = mongoClientFixture(); const data = mongoRows(mongo); const range = mongoRangeFixture(mongo.seed, commit);
  mongo.indexRows.mockResolvedValue([{ name: 'stream_sequence', unique: true, key: { streamId: 1, commitSequence: 1 } },
    { name: 'projection_generation_source_unique', unique: true, key: { projectionName: 1, projectionGeneration: 1, sourceId: 1 } }]);
  mongo.createIndex.mockResolvedValue('projection_generation_source_unique');
  const management = new ManagementFixture(mongo.config);
  const connections: FakeRabbitConnection[] = [];
  const message = rawMessage(); message.fields.exchange = mongo.config.external.exchange; message.fields.routingKey = '';
  message.fields.redelivered = false; message.properties.messageId = commit.commitId;
  message.properties.headers = { collection: 'commits', partitionId: 'partition', streamId: commit.streamId };
  message.content = Buffer.from(JSON.stringify(range.row));
  let early = false;
  const factory: RabbitConnector = async (_uri, options) => {
    const connection = new FakeRabbitConnection(); connections.push(connection);
    Object.assign(connection, { connection: { stream: { localAddress: '127.0.0.1', localPort: 12345, remoteAddress: '127.0.0.1', remotePort: 5672 } } });
    Object.assign(connection.channel, { ch: 1,
      assertQueue: jest.fn(async (_queue, args: { arguments: Record<string, string> }) => {
        management.declare(args.arguments['x-redemeine-bootstrap-id'] ?? ''); data.trace.push('declare'); return {};
      }), bindQueue: jest.fn(async () => { management.bind(); data.trace.push('bind'); return {}; }) });
    connection.channel.consume.mockImplementation(async (_queue, handler) => {
      connection.channel.handler = handler;
      management.consume('actual-consumer-tag', { connectionLabel: options.clientProperties?.connection_name ?? '', channelNumber: 1,
        peerHost: '127.0.0.1', peerPort: 12345, host: '127.0.0.1', port: 5672, user: 'user' });
      if (early) handler(message);
      return { consumerTag: 'actual-consumer-tag' };
    });
    connection.channel.close.mockImplementation(async () => { if (management.queueValue) management.queueValue.consumer_details = []; });
    connection.channel.ack.mockImplementation(() => { data.trace.push('ack'); });
    return connection;
  };
  return { mongo, data, management, range, message, connections, early: () => { early = true; },
    factories: { mongo: mongo.factory, rabbit: factory, management: () => management } };
}
