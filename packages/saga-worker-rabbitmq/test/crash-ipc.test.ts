import { spawn } from 'node:child_process';
import { describe, expect, it } from '@jest/globals';
import { awaitChildReady, awaitSignal, killOwned } from '../integration/crashIpc';
import { observeChild } from '../integration/crashChildTrace';
import { ChildStartupFailure } from '../integration/crashChildStages';
import { safeFailure } from '../integration/crashPhaseEvidence';

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

  it('rejects safe child stage errors immediately, retains phase and kills only that child', async () => {
    const child = owned('process.send({kind:"error",phase:"worker-start",errorClass:"configuration",code:406}); setInterval(() => {}, 1000)');
    const start = Date.now();
    let failure: ChildStartupFailure | undefined;
    try { await awaitSignal(child, value => value.kind === 'ready', 2_000); }
    catch (error) { if (error instanceof ChildStartupFailure) failure = error; }
    expect(Date.now() - start).toBeLessThan(1_000);
    expect(failure?.evidence).toEqual({ kind: 'error', phase: 'worker-start', errorClass: 'configuration', code: 406 });
    expect(safeFailure('child-ready', failure)).toMatchObject({ phase: 'child-ready', childPhase: 'worker-start',
      childClass: 'configuration', code: 406 });
    await expect(killOwned(child)).resolves.toBe('SIGKILL');
  });

  it('reports unknown phase for process death before instrumented IPC', async () => {
    const child = owned('process.exit(2)');
    await expect(awaitSignal(child, value => value.kind === 'ready', 1000)).rejects.toMatchObject({
      evidence: { phase: 'unknown', errorClass: 'exit', code: 2 }
    });
  });

  it('replays buffered ready IPC after source append, preferring a buffered error', async () => {
    const child = owned('setInterval(() => {}, 1000)');
    await expect(awaitChildReady(child, [{ kind: 'ready' }], 100)).resolves.toEqual({ kind: 'ready' });
    await expect(awaitChildReady(child, [{ kind: 'ready' }, { kind: 'error', phase: 'worker-start',
      errorClass: 'configuration', code: 406 }], 100)).rejects.toMatchObject({
      evidence: { phase: 'worker-start', code: 406 }
    });
    await expect(killOwned(child)).resolves.toBe('SIGKILL');
  });

  it('recovery readiness rejects missing IPC and does not accept ready from an exited child', async () => {
    const waiting = owned('setInterval(() => {}, 1000)');
    await expect(awaitChildReady(waiting, [], 30)).rejects.toThrow('timed out');
    await expect(killOwned(waiting)).resolves.toBe('SIGKILL');
    const exited = owned('process.exit(2)');
    await new Promise<void>(resolve => exited.once('exit', () => resolve()));
    await expect(awaitChildReady(exited, [{ kind: 'ready' }], 50)).rejects.toMatchObject({
      evidence: { phase: 'unknown', errorClass: 'exit', code: 2 }
    });
  });

  it.each(['missing', 'error', 'exit', 'buffered'] as const)('does not reuse old ready for %s recovery', async (mode) => {
    const combined = [{ kind: 'ready' }] as import('../integration/crashIpc').CrashSignal[];
    const script = mode === 'buffered' ? 'process.send({kind:"ready"}); setInterval(() => {}, 1000)' :
      mode === 'error' ? 'process.send({kind:"error",phase:"worker-start",errorClass:"configuration",code:406}); setInterval(() => {}, 1000)' :
      mode === 'exit' ? 'process.exit(2)' : 'setInterval(() => {}, 1000)';
    const recovery = owned(script);
    const ready = observeChild(recovery, combined);
    if (mode === 'buffered' || mode === 'error') {
      await new Promise<void>(resolve => recovery.once('message', () => resolve()));
    }
    if (mode === 'buffered') await expect(ready()).resolves.toEqual({ kind: 'ready' });
    else if (mode === 'error') await expect(ready()).rejects.toMatchObject({
      evidence: { phase: 'worker-start', code: 406 }
    });
    else if (mode === 'exit') await expect(ready(200)).rejects.toMatchObject({ evidence: { errorClass: 'exit' } });
    else await expect(ready(30)).rejects.toThrow('timed out');
    expect(combined[0]).toEqual({ kind: 'ready' });
    if (recovery.exitCode === null && recovery.signalCode === null) await killOwned(recovery);
  });
});
