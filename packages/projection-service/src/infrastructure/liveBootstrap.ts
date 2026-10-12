import type { Collection } from 'mongodb';
import { isDeepStrictEqual } from 'node:util';
import type { RuntimeIdentity } from '../runtimeRegistry';
import type { ExternalConfig } from './mongo';
import { bootstrapIdentity, preparedRecord, validateBootstrap, type BootstrapRecord } from './bootstrapRecord';
import { BrokerRefusal } from './brokerSchema';
import type { BrokerTopology } from './brokerTopology';

export interface BootstrapStore {
  load(key: string): Promise<unknown>;
  insert(record: BootstrapRecord): Promise<void>;
  replace(expected: BootstrapRecord, next: BootstrapRecord): Promise<void>;
}

export function mongoBootstrapStore(collection: Pick<Collection<BootstrapRecord>, 'findOne' | 'insertOne' | 'updateOne'>): BootstrapStore {
  return {
    load: (key) => collection.findOne({ _id: key }, { readConcern: { level: 'majority' } }),
    async insert(record) { await collection.insertOne(record, { writeConcern: { w: 'majority' } }); },
    async replace(expected, next) {
      const { _id, ...fields } = next;
      const result = await collection.updateOne({ ...expected, _id }, { $set: fields }, { writeConcern: { w: 'majority' } });
      if (result.matchedCount !== 1) throw new BrokerRefusal('bootstrap_compare_failed');
    }
  };
}

async function writeAndRead(store: BootstrapStore, next: BootstrapRecord, write: () => Promise<void>): Promise<BootstrapRecord> {
  try { await write(); } catch { /* Majority readback is required even after an ambiguous result. */ }
  const stored = await store.load(next._id);
  if (!isDeepStrictEqual(stored, next)) throw new BrokerRefusal('bootstrap_write_uncertain');
  return next;
}

export interface QueueBootstrapActions {
  declare(nonce: string): Promise<void>;
  bind(): Promise<void>;
}

export async function establishBinding(config: ExternalConfig, artifact: RuntimeIdentity, store: BootstrapStore,
  topology: BrokerTopology, actions: QueueBootstrapActions, assertCurrent: () => void): Promise<BootstrapRecord> {
  const identity = bootstrapIdentity(config, artifact);
  const stored = await store.load(identity._id);
  const queue = await topology.queue();
  assertCurrent();
  let record: BootstrapRecord;
  if (stored === null) {
    if (queue !== null) throw new BrokerRefusal('unregistered_queue');
    await topology.checkExchange();
    assertCurrent();
    record = preparedRecord(identity);
    await writeAndRead(store, record, () => store.insert(record));
    assertCurrent();
    await actions.declare(record.queueNonce);
    assertCurrent();
    await actions.bind();
  } else {
    record = validateBootstrap(stored, identity);
    if (queue === null) throw new BrokerRefusal('established_queue_missing');
  }
  assertCurrent();
  await topology.inspect(record.queueNonce);
  assertCurrent();
  if (record.state === 'bound') return record;
  const bound: BootstrapRecord = { ...record, state: 'bound' };
  return writeAndRead(store, bound, () => store.replace(record, bound));
}

export async function claimBootstrapRun(store: BootstrapStore, record: BootstrapRecord, runId: string): Promise<BootstrapRecord> {
  if (record.runState === 'active') {
    if (record.runId !== runId) throw new BrokerRefusal('restart_reconciliation_required');
    return record;
  }
  const active: BootstrapRecord = { ...record, runState: 'active', runId };
  return writeAndRead(store, active, () => store.replace(record, active));
}

export async function finishBootstrapRun(store: BootstrapStore, record: BootstrapRecord): Promise<void> {
  const clean: BootstrapRecord = { ...record, runState: 'clean' };
  await writeAndRead(store, clean, () => store.replace(record, clean));
}
