import type { CommandStartedEvent } from 'mongodb';
import type { LatencySummary, MemorySummary, OperationCounts } from './sourceProgressBenchmarkTypes';

export class MongoOperationObserver {
  private counts: OperationCounts = { reads: 0, writes: 0, indexOperations: 0, transactions: 0 };

  observe = (event: CommandStartedEvent): void => {
    if (event.commandName === 'find' || event.commandName === 'getMore') this.counts.reads += 1;
    if (event.commandName === 'update') this.counts.writes += event.command.updates?.length ?? 0;
    if (event.commandName === 'insert') this.counts.writes += event.command.documents?.length ?? 0;
    if (event.commandName === 'delete') this.counts.writes += event.command.deletes?.length ?? 0;
    if (event.commandName === 'createIndexes') this.counts.indexOperations += event.command.indexes?.length ?? 0;
    if (event.commandName === 'commitTransaction') this.counts.transactions += 1;
  };

  reset(): void {
    this.counts = { reads: 0, writes: 0, indexOperations: 0, transactions: 0 };
  }

  snapshot(): OperationCounts {
    return { ...this.counts };
  }
}

const percentile = (sorted: readonly number[], fraction: number): number => {
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1);
  return Number((sorted[index] ?? 0).toFixed(3));
};

export const summarizeLatency = (values: readonly number[]): LatencySummary => {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    samples: values.length,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    p99Ms: percentile(sorted, 0.99)
  };
};

export class MemoryObserver {
  private readonly before = process.memoryUsage();
  private peak = this.before.heapUsed;

  sample(): void {
    this.peak = Math.max(this.peak, process.memoryUsage().heapUsed);
  }

  summary(): MemorySummary {
    const after = process.memoryUsage();
    return {
      heapUsedBeforeBytes: this.before.heapUsed,
      heapUsedAfterBytes: after.heapUsed,
      peakHeapUsedBytes: this.peak,
      rssAfterBytes: after.rss
    };
  }
}

export const timed = async (operation: () => Promise<void>): Promise<number> => {
  const start = process.hrtime.bigint();
  await operation();
  return Number(process.hrtime.bigint() - start) / 1_000_000;
};
