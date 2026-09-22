export interface OperationCounts {
  reads: number;
  writes: number;
  indexOperations: number;
  transactions: number;
}

export interface LatencySummary {
  samples: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
}

export interface MemorySummary {
  heapUsedBeforeBytes: number;
  heapUsedAfterBytes: number;
  peakHeapUsedBytes: number;
  rssAfterBytes: number;
}

export interface BenchmarkResult {
  adapter: 'in_memory' | 'mongodb';
  scenario: string;
  parameters: Record<string, number | string>;
  latency: LatencySummary;
  memory: MemorySummary;
  bsonBytes: number;
  databaseOperations: OperationCounts | 'not_applicable';
  fenceOperations: number;
  coverageOperations: number;
  warnings: number;
}

export interface BenchmarkParameters {
  eventsPerCommit: number[];
  inlineSourceCounts: number[];
  ownRecordSourceCardinalities: number[];
  samples: number;
  seedBatchSize: number;
}
