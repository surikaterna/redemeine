import { projectionUuidToBase64Url22 } from '@redemeine/projection-runtime-core';
import type { Db } from 'mongodb';
import { budgets, queueName, publisherFeed, publisherStateCollection, publisherCheckpointKey, sourceCollection } from './plan';
import { assert, integer, record, string, waitUntil } from './schema';
import { checkpointFacts, checkpointSummary } from './checkpointDiagnostics';
import { sourceIndexFacts, startupFacts } from './startupEvidence';
import type { OwnedDocker } from './docker';
import type { BrokerHttp } from './http';

export interface ObservedControl { epoch: string; generation: string; registryDigest: string; runState: string }
interface TargetRecord { _id: string; state: { count: number }; sourceProgress: Record<string, number> }
interface FloorRecord { _id: string; coveredThrough: number | null; firstSequence: number }

export class Observations {
  constructor(readonly db: Db, readonly broker: BrokerHttp, readonly vhost: string, readonly docker: OwnedDocker,
    readonly projection: string, readonly signal: AbortSignal) {}

  async health(path = '/ready', signal = this.signal) {
    assert(['/ready', '/live', '/reference-ready'].includes(path), 'invalid_health_path');
    const script = `const response=await fetch('http://127.0.0.1:9464${path}',{signal:AbortSignal.timeout(3000)});const text=await response.text();if(text.length>32768)process.exit(1);console.log(JSON.stringify({status:response.status,body:JSON.parse(text)}));`;
    const value: unknown = JSON.parse(await this.docker.exec(this.projection, ['node', '--input-type=module', '-e', script], signal));
    return record(value);
  }

  async ready(): Promise<void> {
    await waitUntil(async () => {
      try {
        const health = await this.health();
        this.docker.receipt.provenance.projectionStartup = startupFacts(health.body);
        return health.status === 200 && record(health.body).liveConsumerReady === true;
      }
      catch { return false; }
    }, budgets.scenarioMs, this.signal);
    const body = record((await this.health()).body);
    assert(body.sourceHistoricalCompleteness === 'unknown' && body.publisherRecoveryPolicy === 'external_best_effort_on_expiry', 'readiness_completeness_mismatch');
  }

  async control(signal = this.signal): Promise<ObservedControl> {
    const rows = await this.db.collection('rdm_projection_live_control').find({}, { signal }).limit(2).toArray();
    assert(rows.length === 1, 'control_identity_ambiguous');
    const row = record(rows[0]); return { epoch: string(row.epoch), generation: string(row.generation),
      registryDigest: string(row.registryDigest), runState: string(row.runState) };
  }

  async queue(signal = this.signal) { return record(await this.broker.request('GET', ['queues', this.vhost, queueName], undefined, signal)); }

  async ackCount(): Promise<number> { return integer(record((await this.queue()).message_stats).ack); }

  async applied(sourceId: string, sequence: number, expectedCount: number, expectedAcks: number): Promise<Record<string, unknown>> {
    await waitUntil(async () => {
      try {
        const control = await this.control(); const prefix = `rdm_fixture_${control.registryDigest}_${control.epoch}`;
        const floor = await this.db.collection<FloorRecord>(`${prefix}_floors`).findOne({ _id: JSON.stringify([control.epoch, sourceId]) });
        const inline = await this.db.collection<TargetRecord>(`${prefix}_0_documents`).findOne({ _id: 'shared' });
        const own = await this.db.collection<TargetRecord>(`${prefix}_1_documents`).findOne({ _id: 'shared' });
        const queue = await this.queue();
        return floor?.coveredThrough === sequence && inline?.state.count === expectedCount && own?.state.count === expectedCount
          && await this.ackCount() >= expectedAcks && queue.messages_ready === 0 && queue.messages_unacknowledged === 0;
      } catch { return false; }
    }, budgets.scenarioMs, this.signal);
    const control = await this.control(); const prefix = `rdm_fixture_${control.registryDigest}_${control.epoch}`;
    const floor = record(await this.db.collection<FloorRecord>(`${prefix}_floors`).findOne({ _id: JSON.stringify([control.epoch, sourceId]) }));
    const inline = record(await this.db.collection<TargetRecord>(`${prefix}_0_documents`).findOne({ _id: 'shared' }));
    assert(record(inline.sourceProgress)[projectionUuidToBase64Url22(sourceId)] === sequence, 'inline_marker_missing');
    const own = await this.db.collection<{ projectionName: string; projectionGeneration: string; sourceId: string; commitSequence: number }>(`${prefix}_1_dedupe`).findOne({ projectionName: 'model:own-counter',
      projectionGeneration: control.generation, sourceId });
    assert(own?.commitSequence === sequence, 'own_record_progress_missing');
    return { epoch: control.epoch, firstSequence: floor.firstSequence, coveredThrough: sequence, inlineCount: expectedCount,
      ownRecordCount: expectedCount, observedAckCount: await this.ackCount(), ackEvidence: 'actual_queue_management_counter' };
  }

  async checkpoint() {
    return checkpointSummary(await this.checkpointRow(), publisherFeed(this.docker.receipt.runId));
  }

  async checkpointDiagnostic() { return checkpointFacts(await this.checkpointRow(), publisherFeed(this.docker.receipt.runId)); }

  private checkpointRow() {
    return this.db.collection<{ _id: string; [key: string]: unknown }>(publisherStateCollection).findOne({ _id: publisherCheckpointKey },
      { readConcern: { level: 'majority' }, readPreference: 'primary' });
  }

  async sourceIndexes() {
    const cursor = this.db.collection(sourceCollection).listIndexes(); const facts = [];
    try {
      for await (const index of cursor) { assert(facts.length < 16, 'source_index_catalog_capacity'); facts.push(sourceIndexFacts(index)); }
    } finally { await cursor.close(); }
    return facts;
  }
}
