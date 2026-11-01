import { budgets, exchangeName, queueName } from './plan';
import { assert, integer, record, waitUntil } from './schema';
import type { ExternalStack } from './stack';
import { publishMalformed, redeliverOver20 } from './transportFaults';
import type { Observations } from './observations';
import { producerWait } from './scenarioDiagnostics';
import { PublisherReturns, mandatoryReturnIncreased, returnBaseline } from './publisherReturns';
import { verifyAttachment } from './networkPolicy';
import { string } from './schema';
import { assertPolicyRefusal, startupFacts } from './startupEvidence';
import { verifyMalformedRetention } from './malformedRetention';

async function publisherReturnObserver(stack: ExternalStack): Promise<PublisherReturns> {
  const value = await stack.docker.inspectContainer(stack.producer, stack.signal);
  const network = stack.receipt.resources.find((item) => item.kind === 'network');
  if (!network?.id) throw new Error('unowned_publisher_network');
  verifyAttachment(value, network.id, network.name);
  const attached = record(record(record(value.NetworkSettings).Networks)[network.name]);
  return new PublisherReturns(stack.broker, stack.receipt, { vhost: stack.vhost, peerAddress: string(attached.IPAddress) });
}

export async function verifyCheckpointAfterStop(before: Awaited<ReturnType<Observations['checkpoint']>>,
  stop: () => Promise<number>, read: () => ReturnType<Observations['checkpoint']>) {
  assert(before?.kind === 'boundary' && before.hasUuidProgress === false, 'native_boundary_missing');
  if (!before) throw new Error('native_boundary_missing');
  assert(await stop() === 0, 'producer_unrouted_stop_failed');
  const after = await read();
  assert(after?.primaryHash === before.primaryHash && after?.hasUuidProgress === false, 'unrouted_checkpoint_advanced_after_stop');
  return after;
}

async function policyRefusal(stack: ExternalStack): Promise<Record<string, unknown>> {
  await stack.broker.request('PUT', ['policies', stack.vhost, 'hpq1-refuse'], { pattern: '^rdm\\.projection\\.commits$',
    'apply-to': 'queues', priority: 0, definition: { 'max-length': 1 } });
  await stack.docker.start(stack.projection, stack.signal);
  await waitUntil(async () => {
    try { const health = await stack.observer.health(); return health.status === 503 && record(health.body).reason === 'startup_refused'; }
    catch { return false; }
  }, budgets.scenarioMs, stack.signal);
  const refusal = record((await stack.observer.health()).body);
  stack.receipt.provenance.policyRefusalStartup = startupFacts(refusal);
  await stack.receipt.save(); assertPolicyRefusal(refusal);
  assert(await stack.source.db.collection('rdm_projection_live_control').countDocuments({}) === 0, 'policy_refusal_bootstrapped_control');
  assert(await stack.docker.stop(stack.projection, stack.signal) === 0, 'policy_refusal_shutdown_failed');
  await stack.broker.request('DELETE', ['policies', stack.vhost, 'hpq1-refuse']);
  return { unsupportedPolicyRefused: true, controlRows: 0, startup: startupFacts(refusal), executionScope: 'before_owned_binding_interval' };
}

async function noDestination(stack: ExternalStack): Promise<Record<string, unknown>> {
  await stack.docker.start(stack.producer, stack.signal);
  await producerWait(stack, 'boundary', async () => (await stack.observer.checkpoint())?.kind === 'boundary');
  const before = await stack.observer.checkpoint(); assert(before !== null, 'native_boundary_missing');
  const returns = await publisherReturnObserver(stack);
  const initial = await returnBaseline(returns, async () => {
    const warmup = await stack.source.append('probe', [{ type: 'Ignored', target: 'none', amount: 0 }]);
    stack.receipt.provenance.publisherMetricInitialization = { path: 'actual_Tapeworm_append', sourceLabel: 'probe', sequence: warmup.sequence };
  }, (check) => producerWait(stack, 'return_baseline', check));
  stack.receipt.provenance.publisherReturnBaseline = initial;
  await stack.source.append('probe', [{ type: 'Ignored', target: 'none', amount: 0 }]);
  await producerWait(stack, 'mandatory_return', async () => {
    const current = await returns.sample(); return current !== null && mandatoryReturnIncreased(initial, current);
  });
  const early = await stack.observer.checkpoint();
  assert(early?.primaryHash === before?.primaryHash && early?.hasUuidProgress === false, 'unrouted_checkpoint_advanced');
  const after = await verifyCheckpointAfterStop(before, () => stack.docker.stop(stack.producer, stack.signal), () => stack.observer.checkpoint());
  return { actualMandatoryReturnObserved: true, nativeCheckpointAdvanced: false, exactFailedSourceIdentity: 'not_attributed',
    stoppedExitCode: 0, earlyPrimaryHash: early?.primaryHash, afterStopPrimaryHash: after?.primaryHash,
    scope: 'producer_route_failure_not_consumer_attestation', returnMetricSource: 'scoped_publisher_channel_totals' };
}

async function positive(stack: ExternalStack): Promise<Record<string, unknown>> {
  await stack.docker.start(stack.projection, stack.signal); await stack.observer.ready();
  const startupQueries = await stack.source.observeConsumerQueries(stack.projectionAppName);
  assert(startupQueries.observedSourceFinds === 0, 'startup_source_scan');
  await stack.docker.start(stack.producer, stack.signal);
  await waitUntil(async () => (await stack.observer.checkpoint())?.kind === 'changeStream', budgets.scenarioMs, stack.signal);
  const commit = await stack.source.append('primary', [{ amount: 2 }, { amount: 3 }, { type: 'Ignored', amount: 100 }, { target: 'none', amount: 99 }]);
  assert(commit.sequence === 42, 'first42_fixture_mismatch');
  const applied = await stack.observer.applied(commit.sourceId, 42, 5, 2);
  assert(applied.firstSequence === 42, 'first42_floor_mismatch');
  const queue = await stack.observer.queue();
  assert(record(queue.arguments)['x-queue-type'] === 'quorum' && record(queue.arguments)['x-single-active-consumer'] === true
    && record(queue.arguments)['x-delivery-limit'] === -1, 'real_queue_arguments_mismatch');
  return { ...applied, startupQueries, path: 'actual_Tapeworm_append_external_publisher_bound_queue_state_markers_coverage_ack',
    queue: queueName, exchange: exchangeName };
}

async function newSource(stack: ExternalStack) {
  const commit = await stack.source.append('new', [{ amount: 7 }]);
  const evidence = await stack.observer.applied(commit.sourceId, 0, 12, 3);
  assert(evidence.firstSequence === 0, 'new_source_floor_mismatch');
  return { ...evidence, streamUuidConfiguredInConsumer: false };
}

async function backlog(stack: ExternalStack) {
  const epoch = (await stack.observer.control()).epoch;
  assert(await stack.docker.stop(stack.projection, stack.signal) === 0, 'consumer_graceful_stop_failed');
  assert((await stack.observer.control()).runState === 'clean', 'graceful_stop_requires_reconciliation');
  const commit = await stack.source.append('primary', [{ amount: 4 }]); assert(commit.sequence === 43, 'backlog_sequence_mismatch');
  await waitUntil(async () => (await stack.observer.queue()).messages_ready === 1, budgets.scenarioMs, stack.signal);
  await stack.docker.start(stack.projection, stack.signal); await stack.observer.ready();
  const evidence = await stack.observer.applied(commit.sourceId, 43, 16, 4);
  assert(evidence.epoch === epoch, 'restart_epoch_changed'); return { ...evidence, durableBacklogObserved: true };
}

async function nativeResume(stack: ExternalStack) {
  const checkpoint = await stack.observer.checkpoint();
  assert(checkpoint?.kind === 'changeStream' && checkpoint.hasUuidProgress, 'valid_native_checkpoint_missing');
  assert(await stack.docker.stop(stack.producer, stack.signal) === 0, 'producer_graceful_stop_failed');
  const final = await stack.source.append('primary', [{ amount: 6 }]);
  const unseen = await stack.source.append('unseen', [{ amount: 11 }]);
  await stack.docker.start(stack.producer, stack.signal);
  const evidence = await stack.observer.applied(final.sourceId, 44, 33, 6);
  await stack.observer.applied(unseen.sourceId, 0, 33, 6);
  return { ...evidence, finalAndUnseenRecovered: true, laterWakeupAppend: false, producerResumePolicyChanged: false };
}

async function redelivery(stack: ExternalStack) {
  assert(await stack.docker.stop(stack.projection, stack.signal) === 0, 'consumer_graceful_stop_failed');
  assert((await stack.observer.control()).runState === 'clean', 'graceful_stop_requires_reconciliation');
  const commit = await stack.source.append('primary', [{ amount: 1 }]);
  await waitUntil(async () => (await stack.observer.queue()).messages_ready === 1, budgets.scenarioMs, stack.signal);
  const before = await stack.observer.ackCount();
  const transport = await redeliverOver20(stack.transportUri, commit.commitId, stack.signal,
    { unjoined: (label) => stack.receipt.unjoinedOperations.push(label) });
  await waitUntil(async () => (await stack.observer.queue()).messages_ready === 1, budgets.scenarioMs, stack.signal);
  assert(await stack.observer.ackCount() === before, 'transport_probe_acked');
  await stack.docker.start(stack.projection, stack.signal); await stack.observer.ready();
  return { ...transport, ...await stack.observer.applied(commit.sourceId, 45, 34, 7),
    receiptType: 'actual_append_and_controlled_broker_redelivery' };
}

async function malformed(stack: ExternalStack) {
  return verifyMalformedRetention({ queue: (signal) => stack.observer.queue(signal), health: (path, signal) => stack.observer.health(path, signal),
    control: (signal) => stack.observer.control(signal), publish: (signal = stack.signal) => publishMalformed(stack.transportUri, stack.source.source('primary'), signal,
      { unjoined: (label) => stack.receipt.unjoinedOperations.push(label) }), stop: (signal = stack.signal) => stack.docker.stop(stack.projection, signal),
    observe: async (facts) => {
      if (facts.phase === 'empty_baseline') stack.receipt.provenance.malformedBaseline = facts;
      if (facts.phase === 'confirmed_publication') stack.receipt.provenance.malformedPublication = facts.publication;
      if (facts.phase === 'paused_retention') stack.receipt.provenance.malformedPaused = facts;
      stack.receipt.provenance.malformedRetention = facts; await stack.receipt.save();
    } }, stack.signal, { unjoined: (label) => stack.receipt.unjoinedOperations.push(label) });
}

async function quarantine(stack: ExternalStack) {
  await stack.docker.start(stack.projection, stack.signal);
  await waitUntil(async () => {
    const health = await stack.observer.health();
    return health.status === 503 && record(health.body).reason === 'restart_reconciliation_required';
  }, budgets.scenarioMs, stack.signal);
  return { actualRestartUnready: true, operatorMarkerReset: false, delayedServerWriteProof: 'not_run' };
}

export async function runScenarios(stack: ExternalStack): Promise<void> {
  const scenarios = { policy_refusal: policyRefusal, no_destination_checkpoint: noDestination, first42_complete_commit: positive,
    new_source: newSource, graceful_backlog_restart: backlog, native_resume_final_and_unseen: nativeResume,
    redelivery_over20: redelivery, malformed_unacked: malformed, unclean_restart_pause: quarantine };
  for (const [name, work] of Object.entries(scenarios)) await stack.receipt.scenario(name, async () => {
    const evidence = await work(stack);
    const disk = Number((await stack.docker.exec(stack.mongoId, ['du', '-sk', '/data/db'], stack.signal)).split(/\s+/)[0]) * 1024;
    assert(Number.isFinite(disk) && disk <= budgets.mongoDiskBytes, 'mongo_observed_disk_budget');
    return { ...evidence, observedMongoDiskBytes: disk, diskQuotaEnforcedByDocker: false };
  });
  stack.receipt.provenance.queryObservation = await stack.source.observeConsumerQueries(stack.projectionAppName);
}
