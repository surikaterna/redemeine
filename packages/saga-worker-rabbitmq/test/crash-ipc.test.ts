import { spawn } from 'node:child_process';
import { describe, expect, it } from '@jest/globals';
import { awaitSignal, killOwned } from '../integration/crashIpc';

function owned(code: string) {
  return spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
}

describe('owned crash child IPC', () => {
  it('ignores unrelated IPC and rejects pre-barrier exit', async () => {
    const child = owned('process.send({kind:"ready"}); setTimeout(() => process.send({kind:"confirmed",messageId:"kept"}), 40);');
    expect(await awaitSignal(child, value => value.kind === 'confirmed', 1000))
      .toEqual({ kind: 'confirmed', messageId: 'kept' });
    const early = owned('process.exit(2)');
    await expect(awaitSignal(early, value => value.kind === 'confirmed', 1000)).rejects.toThrow('exited before IPC');
  });

  it('times out then SIGKILLs and reaps only the owned child', async () => {
    const child = owned('setInterval(() => {}, 1000)');
    await expect(awaitSignal(child, value => value.kind === 'confirmed', 30)).rejects.toThrow('timed out');
    await expect(killOwned(child)).resolves.toBe('SIGKILL');
    await expect(killOwned(child)).rejects.toThrow('already exited');
  });
});
