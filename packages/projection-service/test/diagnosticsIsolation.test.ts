import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { MongoNetworkError } from 'mongodb';
import { openBrokerMongo } from '../src/infrastructure/mongoBroker';
import { openBrokerRabbit } from '../src/infrastructure/rabbitBroker';
import { startupCode, observeStartup } from '../src/startupDiagnostics';
import { Observations } from '../src/observability';
import { brokerResourceFactory } from '../src/infrastructure/brokerRuntime';
import { SessionFence } from '../src/sessionFence';
import { mongoClientFixture } from './support/mongoClient';
import { brokerClients } from './support/brokerClients';
import { deferred, until } from './support/deferred';
import { builtArtifact } from './fixtures';
import type { RabbitConnector } from '../src/infrastructure/rabbit';
import { BrokerRefusal } from '../src/infrastructure/brokerSchema';

afterEach(() => { jest.restoreAllMocks(); });
const throwingSink = () => { throw new Error('diagnostic_sink_failed'); };

test('Mongo success survives all throwingstage notifications and remains caller-owned until joinedclose', async () => {
  const f = mongoClientFixture();
  const resource = await openBrokerMongo(f.config, await builtArtifact(), new AbortController().signal, f.factory, throwingSink);
  expect(f.close).not.toHaveBeenCalled(); expect(resource.reader).toBeDefined();
  await resource.close(); expect(f.close).toHaveBeenCalledTimes(1);
});

test('R5.1 Mongo sourcefailure isnotmasked;close isattempted andjoined despite throwingerror sink', async () => {
  const f = mongoClientFixture(); const primary = new Error('primary_source_failed'); const closing = deferred<void>();
  f.indexRows.mockRejectedValue(primary); f.close.mockImplementation(() => closing.promise);
  const seen: unknown[] = []; let settled = false;
  const observer = (_stage: unknown, error?: unknown) => { if (error) seen.push(error); throwingSink(); };
  const result = openBrokerMongo(f.config, await builtArtifact(), new AbortController().signal, f.factory, observer)
    .catch((error: unknown) => { settled = true; return error; });
  await until(() => f.close.mock.calls.length === 1);
  expect(settled).toBe(false); expect(seen).toContain(primary); closing.resolve();
  const error = await result; expect(error).toMatchObject({ reason: 'broker_store_unready' });
  expect(String(error)).not.toContain('diagnostic_sink_failed'); expect(f.close).toHaveBeenCalledTimes(1);
});

test('Mongo transientconnectclassification/close remains unchanged with brokeninitialsink', async () => {
  const f = mongoClientFixture(); f.connect.mockRejectedValue(new MongoNetworkError('secret-canary'));
  await expect(openBrokerMongo(f.config, await builtArtifact(), new AbortController().signal, f.factory, throwingSink))
    .rejects.toMatchObject({ name: 'Error', message: 'connection_transient' });
  expect(f.close).toHaveBeenCalledTimes(1);
});

test('Rabbit success survives throwingchannel/identity notifications and joinedclose still belongs tocaller', async () => {
  const f = brokerClients();
  const resource = await openBrokerRabbit(f.mongo.config, new AbortController().signal, f.factories.rabbit, throwingSink);
  expect(resource.channel.identity().channelNumber).toBe(1); expect(f.connections[0]?.close).not.toHaveBeenCalled();
  await resource.close(); expect(f.connections[0]?.close).toHaveBeenCalledTimes(1);
});

test('nativeRabbit channelerror remains mappedprimaryfailure andclosejoined evenwhenerrorsinkthrows', async () => {
  const f = brokerClients(); const primary = new Error('native_channel_failed'); const closing = deferred<void>();
  const seen: unknown[] = []; const native = f.factories.rabbit;
  const factory: RabbitConnector = async (uri, options) => {
    const connection = await native(uri, options); f.connections[0]?.createChannel.mockRejectedValue(primary);
    f.connections[0]?.close.mockImplementation(() => closing.promise); return connection;
  };
  let settled = false;
  const result = openBrokerRabbit(f.mongo.config, new AbortController().signal, factory,
    (_stage, error) => { if (error) seen.push(error); throwingSink(); }).catch((error: unknown) => { settled = true; return error; });
  await until(() => f.connections[0]?.close.mock.calls.length === 1);
  expect(settled).toBe(false); expect(seen).toContain(primary); closing.resolve();
  expect(await result).toMatchObject({ reason: 'rabbit_prerequisite_failed' }); expect(f.connections[0]?.close).toHaveBeenCalledTimes(1);
});

test('classifierthrowingmessage/reason getters are contained and do not leak or replace acquisition authority', () => {
  const error = new Error(); Object.defineProperty(error, 'message', { get: throwingSink });
  expect(startupCode(error)).toBe('unknown_error');
  const refusal = new BrokerRefusal('broker_policy_unproven'); Object.defineProperty(refusal, 'reason', { get: throwingSink });
  expect(startupCode(refusal)).toBe('unknown_error');
  const observations = new Observations();
  expect(() => observeStartup((stage, error) => observations.startup(stage, error), 'source_reader', error)).not.toThrow();
  expect(observations.snapshot(false)).toMatchObject({ startupStage: 'source_reader', startupCode: 'unknown_error' });
});

test('Rabbit identityfailure cannot be turned into successfulacquisition or skippedclose by a throwing sink', async () => {
  const f = brokerClients(); const native = f.factories.rabbit;
  const factory: RabbitConnector = async (uri, options) => {
    const connection = await native(uri, options); Object.assign(f.connections[0]?.channel ?? {}, { ch: 0 }); return connection;
  };
  await expect(openBrokerRabbit(f.mongo.config, new AbortController().signal, factory, throwingSink))
    .rejects.toMatchObject({ reason: 'rabbit_prerequisite_failed' });
  expect(f.connections[0]?.close).toHaveBeenCalledTimes(1);
});

test('completecomposition andconsumerstart survive brokenObservations method withnormaladmission andclose', async () => {
  const f = brokerClients(); const observations = new Observations(); jest.spyOn(observations, 'startup').mockImplementation(throwingSink);
  jest.spyOn(observations, 'consumer').mockImplementation(() => Promise.reject(new Error('consumer_sink_failed')));
  const resource = await brokerResourceFactory(f.mongo.config, await builtArtifact(), observations, f.factories)
    (new AbortController().signal, new SessionFence());
  await resource.start(); expect(resource.worker.getStatus().accepting).toBe(true);
  await resource.worker.stop(); await resource.close(); expect(f.connections[0]?.close).toHaveBeenCalledTimes(1);
});

test('asyncsink rejections/hostilethenable getters are observed in disposablechild without awaiting or referencedtimers', () => {
  const source = resolve(__dirname, '../src/startupDiagnostics.ts');
  const script = `import {observeStartup} from ${JSON.stringify(source)};
let unhandled=0;const listener=()=>{unhandled++};process.on('unhandledRejection',listener);
try{
observeStartup(()=>Promise.reject(new Error('sink_rejected')),'source_reader');
observeStartup(()=>({get then(){throw new Error('then_getter')}}),'binding');
observeStartup(()=>new Promise(()=>{}),'consumer_start');
const rejected=Promise.reject(new Error('own_then_rejected'));Object.defineProperty(rejected,'then',{get(){throw new Error('own_then_getter')}});
observeStartup(()=>rejected,'rabbit_identity');
await new Promise(setImmediate);console.log(JSON.stringify({unhandled}));process.exitCode=unhandled?1:0;
}finally{process.removeListener('unhandledRejection',listener)}`;
  const result = spawnSync('pnpm', ['exec', 'node', '--import', 'tsx', '--input-type=module', '-e', script], {
    cwd: resolve(__dirname, '../../..'), encoding: 'utf8', timeout: 5000
  });
  expect(result.error).toBeUndefined(); expect(result.status).toBe(0); expect(JSON.parse(result.stdout)).toEqual({ unhandled: 0 });
});
