import type { LiveFeedEvidencePort, LiveFeedSession } from '@redemeine/projection-runtime-core';

export class SessionFence {
  private session: LiveFeedSession | undefined;
  private stopped = false;

  wrap(evidence: LiveFeedEvidencePort): LiveFeedEvidencePort {
    return { openSession: async (start, channel) => {
      if (this.stopped) return { status: 'unproven', reason: 'host_stopping' };
      const result = await evidence.openSession(start, channel);
      if (result.status === 'unproven') return result;
      if (this.stopped) {
        result.value.invalidate();
        return { status: 'unproven', reason: 'host_stopping' };
      }
      this.session = result.value;
      return result;
    } };
  }

  current(): boolean {
    if (this.stopped || !this.session) return false;
    try { this.session.assertCurrent(); return true; }
    catch { this.stop(); return false; }
  }

  stop(): void {
    this.stopped = true;
    try { this.session?.invalidate(); } catch { /* Admission remains fenced even if a provider fails cleanup. */ }
  }

  get halted(): boolean { return this.stopped; }
}
