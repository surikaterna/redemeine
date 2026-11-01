import { Observations } from '../src/observability';
import { parseConfig } from '../src/config';
import { until } from './support/deferred';
import { hostFixture, modelResource } from './support/hostFixture';
import { request } from './support/http';

test('loopback reference health never becomes production readiness; expiry is latched by health read', async () => {
  let model: ReturnType<typeof modelResource> | undefined;
  const fixture = hostFixture(async (_signal, fence) => { model = modelResource(fence); return model.resource; });
  try {
    await until(() => fixture.host.snapshot().referenceReady);
    expect((await request(fixture.host.healthPort, '/live')).status).toBe(200);
    expect((await request(fixture.host.healthPort, '/ready')).status).toBe(503);
    const reference = await request(fixture.host.healthPort, '/reference-ready');
    expect(reference.status).toBe(200);
    expect(JSON.parse(reference.text)).toMatchObject({ referenceOnly: true, productionReady: false });
    model?.feed.loseContinuity();
    expect((await request(fixture.host.healthPort, '/reference-ready')).status).toBe(503);
    expect((await request(fixture.host.healthPort, '/live')).status).toBe(200);
    expect((await request(fixture.host.healthPort, '/metrics')).text).toContain('session_invalid');
  } finally { fixture.signals.emit('SIGTERM'); expect(await fixture.done).toBe(0); }
});

test('poison circuit remains live/unready and logs/HTTP never echo error, metadata, request URL or source labels', async () => {
  const fixture = hostFixture(async () => { throw new Error('secret-canary mongodb://user:password/source-id'); });
  try {
    await until(() => fixture.host.snapshot().phase === 'paused');
    expect((await request(fixture.host.healthPort, '/live')).status).toBe(200);
    expect((await request(fixture.host.healthPort, '/reference-ready')).status).toBe(503);
    for (const path of ['/ready', '/metrics', '/secret-canary']) {
      const response = await request(fixture.host.healthPort, path);
      expect(response.text).not.toMatch(/secret-canary|password|source-id|mongodb/);
    }
    expect(fixture.lines.join('')).not.toMatch(/secret-canary|password|source-id|mongodb/);
  } finally { fixture.signals.emit('SIGTERM'); expect(await fixture.done).toBe(0); }
});

test('coordinator observations allowlist reasons and report measured turn time, not invented CDC lag', () => {
  const observations = new Observations();
  observations.result({ status: 'paused', processedCommits: 2, coveredThrough: 42, reason: 'secret-canary-payload' }, 10.8);
  const snapshot = observations.snapshot(false);
  expect(snapshot).toMatchObject({ processedCommits: 2, pausedTurns: 1, lastTurnMilliseconds: 11,
    lastTurnReason: 'turn_refused', publisherLag: 'unknown', cdcLag: 'unknown' });
  expect(JSON.stringify(snapshot)).not.toContain('secret-canary');
});

test('separate typed serve selection preserves finite default and cannot configure state namespace', () => {
  expect(parseConfig({ PROJECTION_MODE: 'reference' }, []).execution).toBe('once');
  expect(parseConfig({ PROJECTION_MODE: 'reference', PROJECTION_EXECUTION: 'serve' }, []).execution).toBe('serve');
  expect(() => parseConfig({ PROJECTION_MODE: 'reference', PROJECTION_EXECUTION: 'daemon' }, [])).toThrow();
  expect(() => parseConfig({ PROJECTION_MODE: 'reference', PROJECTION_STATE_DIR: '/tmp/secret-canary' }, [])).toThrow();
});
