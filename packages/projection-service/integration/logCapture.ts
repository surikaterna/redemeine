import { createHash } from 'node:crypto';
import { sanitizedLogs } from './receipts';
import { budgets, QualificationError } from './plan';

export const logLimits = Object.freeze({ tailLines: 200, lineBytes: 16384, records: 200, rawBytes: 33554432 });
export interface CapturedLogs {
  body: string; stdoutSha256: string; stderrSha256: string; rawBytes: number; oversizedLines: number; omittedRecords: number;
}

class Lines {
  private fragments: Buffer[] = [];
  private bytes = 0;
  private discarded = false;
  constructor(private readonly emit: (line: string | undefined) => void) {}

  push(chunk: Buffer): void {
    let start = 0;
    while (start < chunk.length) {
      const end = chunk.indexOf(10, start); const stop = end === -1 ? chunk.length : end;
      const part = chunk.subarray(start, stop); this.bytes += part.length;
      // Never interpret an oversized line's suffix as a fresh, valid log record.
      if (this.bytes > logLimits.lineBytes) { this.discarded = true; this.fragments = []; }
      else if (!this.discarded) this.fragments.push(Buffer.from(part));
      if (end !== -1) this.finish();
      start = stop + 1;
    }
  }

  finish(): void {
    if (this.bytes || this.discarded) this.emit(this.discarded ? undefined : Buffer.concat(this.fragments).toString('utf8'));
    this.fragments = []; this.bytes = 0; this.discarded = false;
  }
}

export class LogCapture {
  private readonly observations: Record<string, unknown>[] = [];
  private readonly lifecycle = new Set<string>();
  private readonly stdoutHash = createHash('sha256');
  private readonly stderrHash = createHash('sha256');
  private readonly rawHash = createHash('sha256');
  private readonly stdoutLines = new Lines((line) => this.line(line));
  private readonly stderrLines = new Lines((line) => this.line(line));
  private bytes = 0;
  private oversized = 0;
  private omitted = 0;
  private lines = 0;

  push(stream: 'stdout' | 'stderr', chunk: Buffer): void {
    this.bytes += chunk.length;
    if (this.bytes > logLimits.rawBytes) throw new QualificationError('qualification_log_input_capacity');
    (stream === 'stdout' ? this.stdoutHash : this.stderrHash).update(chunk); this.rawHash.update(chunk);
    (stream === 'stdout' ? this.stdoutLines : this.stderrLines).push(chunk);
  }

  private line(line: string | undefined): void {
    this.lines += 1;
    if (line === undefined) { this.oversized += 1; return; }
    const value: { observations: Record<string, unknown>[]; publisherLifecycle: string[] } = JSON.parse(sanitizedLogs(line));
    for (const observation of value.observations) {
      if (Object.keys(observation).length === 0) continue;
      if (this.observations.length === logLimits.records) this.omitted += 1;
      else this.observations.push(observation);
    }
    for (const kind of value.publisherLifecycle) this.lifecycle.add(kind);
  }

  result(): CapturedLogs {
    this.stdoutLines.finish(); this.stderrLines.finish();
    const stdoutSha256 = this.stdoutHash.digest('hex'); const stderrSha256 = this.stderrHash.digest('hex');
    const body = `${JSON.stringify({ observations: this.observations, publisherLifecycle: [...this.lifecycle],
      rawSha256: this.rawHash.digest('hex'), rawDigestOrder: 'received_stream_chunks', stdoutSha256, stderrSha256,
      rawBytes: this.bytes, linesSeen: this.lines, oversizedLines: this.oversized, omittedRecords: this.omitted,
      truncated: this.oversized > 0 || this.omitted > 0, tailLines: logLimits.tailLines, fullHistory: false,
      unstructuredOutput: 'omitted', captureMode: 'bounded_stream_sanitization' })}\n`;
    if (Buffer.byteLength(body) > budgets.commandBytes) throw new QualificationError('qualification_log_output_capacity');
    return { body, stdoutSha256, stderrSha256, rawBytes: this.bytes, oversizedLines: this.oversized, omittedRecords: this.omitted };
  }
}
