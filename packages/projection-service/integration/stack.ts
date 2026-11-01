import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MongoClient } from 'mongodb';
import { budgets, exchangeName, images, partitionId, sourceCollection, producerFeedEnvironment, projectionFeedEnvironment,
  publisherStateCollection, publisherCheckpointKey, publisherUsername } from './plan';
import { assert, record, string, waitUntil } from './schema';
import { assertPublisherPin, projectionContext, publisherContext, snapshot } from './provenance';
import type { Receipts } from './receipts';
import type { OwnedDocker } from './docker';
import { BrokerHttp } from './http';
import { SourceFixtures } from './fixtures';
import { Observations } from './observations';
import { initializeMongoReplica } from './mongoReadiness';

export function credentials() {
  return { mongoUser: 'hpq1_root', mongoPassword: randomBytes(24).toString('hex'), rabbitUser: 'hpq1_admin',
    rabbitPassword: randomBytes(24).toString('hex'), publisherUser: publisherUsername, publisherPassword: randomBytes(24).toString('hex'),
    consumerUser: 'hpq1_consumer', consumerPassword: randomBytes(24).toString('hex'), key: randomBytes(96).toString('base64') };
}
type Credentials = ReturnType<typeof credentials>;

export function rabbitUri(user: string, password: string, vhost: string, host = 'rabbit', port = 5672): string {
  return `amqp://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(vhost)}`;
}

async function prepareImages(root: string, docker: OwnedDocker, receipt: Receipts, signal: AbortSignal) {
  const input = await snapshot(root); receipt.provenance.projectionSource = { base: input.base, digest: input.digest, count: input.count };
  await writeFile(join(receipt.root, 'projection-source.manifest'), input.manifest, { mode: 0o600 });
  const producer = await publisherContext(join(receipt.root, 'publisher-context'));
  const projection = await projectionContext(root, join(receipt.root, 'projection-context'));
  receipt.provenance.publisherSource = producer; receipt.provenance.projectionArtifact = projection;
  const mongoImage = await docker.pull(images.mongo, signal); const rabbitImage = await docker.pull(images.rabbit, signal);
  const nodeImage = await docker.pull(images.node, signal); const producerBase = await docker.pull(images.publisherBase, signal);
  const producerImage = await docker.build('producer-image', join(receipt.root, 'publisher-context'),
    join(receipt.root, 'publisher-context/packages/tapeworm_dispatcher_mdb_rmq/Dockerfile'),
    { REVISION: producer.revision, VERSION: producer.version, CORE_VERSION: producer.coreVersion }, signal);
  await assertPublisherPin();
  await docker.unchangedBase(images.publisherBase, producerBase.id, signal);
  const projectionImage = await docker.build('projection-image', join(receipt.root, 'projection-context'),
    join(receipt.root, 'projection-context/Projection.Dockerfile'), { NODE_IMAGE: nodeImage.reference,
      SOURCE_MANIFEST: input.digest, ARTIFACT_DIGEST: projection.artifactDigest }, signal);
  assert((await snapshot(root)).digest === input.digest, 'projection_source_changed_during_build');
  return { mongoImage: mongoImage.id, rabbitImage: rabbitImage.id, nodeImage: nodeImage.id, producerImage, projectionImage };
}

async function mongo(docker: OwnedDocker, network: string, image: string, node: string, creds: Credentials, signal: AbortSignal) {
  const data = await docker.volume('mongo-data', signal); const keys = await docker.volume('mongo-key', signal);
  const initialize = await docker.container({ role: 'key-init', image: node, network, env: { HPQ1_KEY: creds.key },
    mounts: [{ volume: keys, target: '/keys' }], command: ['node', '-e',
      'const fs=require("node:fs");fs.writeFileSync("/keys/key",process.env.HPQ1_KEY,{mode:0o400});fs.chownSync("/keys/key",999,999);'] }, signal);
  await docker.start(initialize, signal);
  await waitUntil(async () => record((await docker.inspectContainer(initialize, signal)).State).Running === false, budgets.scenarioMs, signal);
  assert(await docker.stop(initialize, signal) === 0, 'mongo_key_initialization_failed');
  const id = await docker.container({ role: 'mongo', image, network, env: { MONGO_INITDB_ROOT_USERNAME: creds.mongoUser,
    MONGO_INITDB_ROOT_PASSWORD: creds.mongoPassword }, ports: [27017], mounts: [{ volume: data, target: '/data/db' },
      { volume: keys, target: '/run/keys', readonly: true }], command: ['mongod', '--replSet', 'rs0', '--bind_ip_all',
        '--keyFile', '/run/keys/key', '--oplogSize', '64', '--wiredTigerCacheSizeGB', '0.25'] }, signal);
  await docker.start(id, signal);
  const shell = ['mongosh', '--quiet', '--username', creds.mongoUser, '--password', creds.mongoPassword, '--authenticationDatabase', 'admin', '--eval'];
  await initializeMongoReplica((script) => docker.exec(id, [...shell, script], signal), signal);
  return id;
}

async function rabbit(docker: OwnedDocker, network: string, image: string, creds: Credentials, vhost: string, signal: AbortSignal) {
  const id = await docker.container({ role: 'rabbit', image, network, env: { RABBITMQ_DEFAULT_USER: creds.rabbitUser,
    RABBITMQ_DEFAULT_PASS: creds.rabbitPassword, RABBITMQ_DEFAULT_VHOST: vhost }, ports: [5672, 15672] }, signal);
  await docker.start(id, signal);
  const broker = new BrokerHttp(await docker.port(id, 15672, signal), creds.rabbitUser, creds.rabbitPassword, signal);
  await waitUntil(async () => { try { const value = record(await broker.request('GET', ['overview'])); return value.rabbitmq_version === '4.1.4'; } catch { return false; } }, budgets.scenarioMs, signal);
  await broker.request('PUT', ['exchanges', vhost, exchangeName], { type: 'headers', durable: true, auto_delete: false, internal: false, arguments: {} });
  for (const [user, password] of [[creds.publisherUser, creds.publisherPassword], [creds.consumerUser, creds.consumerPassword]]) {
    if (!user || !password) throw new Error('missing_generated_credential');
    await broker.request('PUT', ['users', user], { password, tags: '' });
  }
  const exchange = '^tapeworm\\.master\\.commits$'; const queue = '^rdm\\.projection\\.commits$';
  await broker.request('PUT', ['permissions', vhost, creds.publisherUser], { configure: exchange, write: exchange, read: '^$' });
  await broker.request('PUT', ['permissions', vhost, creds.consumerUser], { configure: queue, write: queue,
    read: '^(rdm\\.projection\\.commits|tapeworm\\.master\\.commits)$' });
  return { id, broker, port: await docker.port(id, 5672, signal) };
}

async function runtimeContainers(docker: OwnedDocker, built: Awaited<ReturnType<typeof prepareImages>>, network: string,
  creds: Credentials, database: string, vhost: string, receipt: Receipts, signal: AbortSignal) {
  const auth = `${creds.mongoUser}:${creds.mongoPassword}`;
  const internalMongo = `mongodb://${auth}@mongo:27017/${database}?authSource=admin&replicaSet=rs0`;
  const producer = await docker.container({ role: 'producer', image: built.producerImage, network, env: {
    ...producerFeedEnvironment, MONGODB_URI: `${internalMongo}&appName=hpq1-publisher-${receipt.runId}`, DATABASE: database,
    RABBITMQ_URI: rabbitUri(creds.publisherUser, creds.publisherPassword, vhost),
    RESUME_COLLECTION: publisherStateCollection, WATCH_MODE: 'changeStream', FEED_ID: `hpq1_${receipt.runId}`,
    CHECKPOINT_KEY: publisherCheckpointKey } }, signal);
  const state = await docker.volume('projection-state', signal);
  const projection = await docker.container({ role: 'projection', image: built.projectionImage, network,
    mounts: [{ volume: state, target: '/var/lib/redemeine-projection' }], env: { PROJECTION_MODE: 'external', PROJECTION_EXECUTION: 'serve',
      MONGODB_URI: `${internalMongo}&appName=hpq1-projection-${receipt.runId}`, MONGODB_DATABASE: database,
      ...projectionFeedEnvironment,
      RABBITMQ_URI: rabbitUri(creds.consumerUser, creds.consumerPassword, vhost), RABBITMQ_VHOST: vhost,
      RABBITMQ_MANAGEMENT_URL: 'http://127.0.0.1:15672', RABBITMQ_MANAGEMENT_USERNAME: creds.rabbitUser,
      RABBITMQ_MANAGEMENT_PASSWORD: creds.rabbitPassword } }, signal);
  return { producer, projection };
}

export async function createStack(root: string, docker: OwnedDocker, receipt: Receipts, signal: AbortSignal, clients: Set<MongoClient>) {
  const built = await prepareImages(root, docker, receipt, signal); const creds = credentials(); const vhost = `hpq1_${receipt.runId}`;
  const network = await docker.network(signal);
  const mongoId = await mongo(docker, network, built.mongoImage, built.nodeImage, creds, signal);
  const broker = await rabbit(docker, network, built.rabbitImage, creds, vhost, signal);
  const database = `hpq1_${receipt.runId}`; const auth = `${creds.mongoUser}:${creds.mongoPassword}`;
  const client = new MongoClient(`mongodb://${auth}@127.0.0.1:${await docker.port(mongoId, 27017, signal)}/${database}?authSource=admin&replicaSet=rs0&directConnection=true`,
    { appName: 'hpq1-harness', connectTimeoutMS: 5000, serverSelectionTimeoutMS: 5000, socketTimeoutMS: 10000, timeoutMS: 10000, maxPoolSize: 2 });
  clients.add(client);
  await client.connect(); assert(!signal.aborted, 'qualification_stopping');
  const source = await SourceFixtures.open(client, database, signal); await source.seed();
  await source.db.command({ profile: 2, slowms: 0 });
  const { producer, projection } = await runtimeContainers(docker, built, network, creds, database, vhost, receipt, signal);
  receipt.provenance.topology = { exchange: exchangeName, queue: 'rdm.projection.commits', vhost, collection: sourceCollection, partitionId,
    tenantFilter: 'none_shared_partition', tenantIsolation: 'not_qualified', managementCredential: 'disposable_admin_observer_not_production_acl_certification',
    defaultExchangePublishing: 'restricted_publisher_and_trusted_consumer_assumption' };
  receipt.provenance.dataset = { inactiveSources: budgets.inactiveSources, priorPrimaryCommits: 42, actualPrimedRows: source.committed };
  receipt.provenance.mongoVersion = record(await client.db('admin').command({ buildInfo: 1 })).version;
  assert(receipt.provenance.mongoVersion === '8.0.17', 'mongo_version_mismatch');
  const observer = new Observations(source.db, broker.broker, vhost, docker, projection, signal);
  receipt.provenance.sourceIndexes = await observer.sourceIndexes();
  return { docker, receipt, client, source, mongoId, rabbitId: broker.id, producer, projection, vhost,
    observer, broker: broker.broker,
    transportUri: rabbitUri(creds.rabbitUser, creds.rabbitPassword, vhost, '127.0.0.1', broker.port),
    projectionAppName: `hpq1-projection-${receipt.runId}`, signal };
}

export type ExternalStack = Awaited<ReturnType<typeof createStack>>;
