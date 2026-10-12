import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import { ProjectionHost } from '../src/host';
import { Observations } from '../src/observability';
import { referenceResource } from '../src/reference/hostResource';
import { builtArtifact, referenceConfig } from './fixtures';
import { until } from './support/deferred';

test.each(['clock_jump', 'blocked_sink', 'blocked_throwing_sink'])('%s cannot erase elapsed deadline or release ownership', async (mode) => {
  const artifact = await builtArtifact();
  const config = { ...referenceConfig, healthPort: 0, shutdownTimeoutMs: 30 };
  const signals = new EventEmitter();
  const close = jest.fn(async () => {});
  const forceExit = jest.fn();
  const lines: string[] = [];
  let clock = 100;
  const observations = new Observations((line) => {
    lines.push(line);
    const view = JSON.parse(line);
    if (view.phase !== 'stopping' || view.reason !== 'shutdown') return;
    if (mode === 'clock_jump') { clock = 130; return; }
    const end = performance.now() + 120;
    while (performance.now() < end) { /* Model synchronous output blocking timer delivery. */ }
    if (mode === 'blocked_throwing_sink') throw new Error('secret-canary');
  });
  const host = new ProjectionHost(config, { acquire: async () => ({ close }), signals, forceExit, observations,
    ...(mode === 'clock_jump' ? { now: () => clock } : {}),
    connect: async (_signal, fence) => referenceResource(artifact, config, fence, observations) });
  const done = host.start();
  await until(() => host.snapshot().referenceReady);
  signals.emit('SIGTERM');
  expect(await done).toBe(124);
  expect(close).not.toHaveBeenCalled();
  expect(host.snapshot()).toMatchObject({ owned: true, phase: 'stopping', reason: 'shutdown_deadline', referenceReady: false });
  host.stop();
  signals.emit('SIGINT');
  await new Promise<void>((resolve) => setTimeout(resolve, 45));
  expect(close).not.toHaveBeenCalled();
  expect(forceExit).toHaveBeenCalledTimes(1);
  expect(forceExit).toHaveBeenCalledWith(124);
  expect(lines.join('\n')).not.toMatch(/"phase":"stopped"|secret-canary/);
});
