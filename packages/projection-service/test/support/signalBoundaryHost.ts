import { writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VerifiedArtifact } from '../../src/artifact';
import { parseConfig } from '../../src/config';
import { ProjectionHost } from '../../src/host';
import { Observations } from '../../src/observability';
import { acquireAtRoot } from '../../src/ownership';
import { createProcessSignalSource } from '../../src/processSignals';
import { referenceResource } from '../../src/reference/hostResource';
import type { SignalSource } from '../../src/shutdown';

const root = process.argv[2];
const mode = process.argv[3];
const injected = process.argv[4];
if (!root || (mode !== 'deadline' && mode !== 'graceful') || (injected !== 'SIGINT' && injected !== 'SIGTERM')) {
  throw new Error('invalid_test_case');
}
const guarded = createProcessSignalSource(process);
const signals: SignalSource = {
  on: (event, listener) => guarded.on(event, listener),
  removeListener(event, listener) {
    guarded.removeListener(event, listener);
    writeSync(1, `${JSON.stringify({ event: 'detached', signal: event, listeners: process.listenerCount(event) })}\n`);
    // Inject a real signal at the precise native-default window, not after a guessed delay.
    if (event === injected) process.kill(process.pid, event);
  }
};
const artifact = await VerifiedArtifact.read(resolve(dirname(fileURLToPath(import.meta.url)), '../../dist'));
const config = parseConfig({ PROJECTION_MODE: 'reference', SHUTDOWN_TIMEOUT_MS: '100' }, []);
const observations = new Observations((line) => {
  writeSync(1, `${line}\n`);
  if (JSON.parse(line).phase !== 'reference_active') return;
  writeSync(1, `${JSON.stringify({ event: 'ready', int: process.listenerCount('SIGINT'), term: process.listenerCount('SIGTERM') })}\n`);
  setImmediate(() => process.kill(process.pid, 'SIGTERM'));
});
const host = new ProjectionHost({ ...config, healthPort: 0 }, {
  acquire: (signal) => acquireAtRoot(root, signal, { ancestorBoundary: tmpdir() }), signals, observations,
  forceExit: (code) => { writeSync(1, `force:${code}\n`); process.exit(code); },
  async connect(_signal, fence) {
    const resource = referenceResource(artifact, config, fence, observations);
    return mode === 'deadline' ? { ...resource, close: () => new Promise<void>(() => {}) } : resource;
  }
});
process.exitCode = await host.start();
