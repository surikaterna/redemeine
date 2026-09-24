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
  /** Requests actually submitted to the measured adapter. */
  logicalOperations: number;
  fenceOperations: number;
  /** Successful calls to the transport order port, never inferred from commit requests. */
  coverageOperations: number;
  warnings: number;
  setup?: Record<string, number | string>;
}

export interface BenchmarkParameters {
  eventsPerCommit: number[];
  inlineSourceCounts: number[];
  ownRecordSourceCardinalities: number[];
  samples: number;
  seedBatchSize: number;
}
