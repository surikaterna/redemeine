import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProcessSignalSource } from '../src/processSignals';
import { attachSignals } from '../src/shutdown';

test('process guards are lazy, bounded, and do not retain detached host callbacks', () => {
  const source = new EventEmitter();
  const signals = createProcessSignalSource(source);
  expect(source.eventNames()).toEqual([]);
  const stop = jest.fn();
  const detach = attachSignals(signals, stop);
  source.emit('SIGINT'); source.emit('SIGTERM');
  expect(stop).toHaveBeenCalledTimes(2);
  detach();
  for (const event of ['SIGINT', 'SIGTERM']) {
    expect(source.listenerCount(event)).toBe(1);
    expect(source.listeners(event)).not.toContain(stop);
    source.emit(event);
  }
  expect(stop).toHaveBeenCalledTimes(2);
  const second = jest.fn();
  const detachAgain = attachSignals(signals, second);
  expect(source.listenerCount('SIGINT')).toBe(2);
  detachAgain();
  expect(source.listenerCount('SIGINT')).toBe(1);
  expect(source.listenerCount('SIGTERM')).toBe(1);
});

describe.each(['deadline', 'graceful'])('%s terminal signal handling', (mode) => {
  test.each(['SIGINT', 'SIGTERM'])('real %s immediately at detach preserves intended exit and terminates naturally', (signal) => {
    const root = mkdtempSync(join(tmpdir(), 'projection-signal-boundary-'));
    try {
      const result = spawnSync(process.execPath, [join(__dirname, '.built/signalBoundaryHost.js'), root, mode, signal], {
        cwd: root, env: {}, encoding: 'utf8', timeout: 3000
      });
      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status).toBe(mode === 'deadline' ? 124 : 0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toContain('"event":"ready","int":2,"term":2');
      expect(result.stdout).toContain(`"event":"detached","signal":"${signal}","listeners":1`);
      if (mode === 'deadline') {
        expect(result.stdout.match(/force:124/g)).toHaveLength(1);
        expect(result.stdout).not.toContain('"phase":"stopped"');
      } else {
        expect(result.stdout).toContain('"phase":"stopped"');
        expect(result.stdout).not.toContain('force:');
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
