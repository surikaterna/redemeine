import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { assertAcceptedBaseline } from '../src';
import { stackManifest, SOURCE_ID } from '../integration/realStackFixtures';
import { benchmarkCoverageBaseline, coverageBenchmarkResult, measureCoverageAdvances,
  prepareCoverageAdmission, type CoverageOrderPort } from '../integration/sourceProgressCoverageBenchmark';

test('one explicit empty accepted baseline precedes a synthetic admission, not 100k per-row anchors', async () => {
  const record = benchmarkCoverageBaseline();
  assertAcceptedBaseline(record, stackManifest('benchmark-coverage'));
  expect(record).toMatchObject({ version: 2, kind: 'existing', sourceId: SOURCE_ID,
    lastAcceptedSequence: -1, startAnchor: 0, acknowledgesUnverifiedHistoryAndCutoff: true });
  expect(record.strategyScope.map((entry) => entry.strategy)).toEqual(['own_record', 'none', 'in_document', 'own_record']);
  const calls: string[] = [];
  const store: CoverageOrderPort = {
    async installAcceptedBaseline(row) { expect(row).toBe(record); calls.push('baseline'); },
    async admitForDispatch(commit, queue) { expect([commit.streamId, commit.commitSequence, queue])
      .toEqual([SOURCE_ID, 0, 'benchmark-coverage']); calls.push('admission'); },
    async advanceCoverage({ expectedSequence, sequence }) {
      expect(expectedSequence).toBe(sequence === 0 ? null : sequence - 1);
      calls.push('advance');
    }
  };
  await prepareCoverageAdmission(store, record);
  const measured = await measureCoverageAdvances(store, 30);
  expect(calls).toEqual(['baseline', 'admission', ...Array.from({ length: 30 }, () => 'advance')]);
  expect(measured.coverageOperations).toBe(30);
  const ownSource = readFileSync(resolve(__dirname, '../integration/sourceProgressOwnRecordBenchmark.ts'), 'utf8');
  expect(ownSource).not.toMatch(/installAcceptedBaseline|admitForDispatch/);
});

test('coverage labelling separates observed setup from synthetic CAS measurement', () => {
  const setup = { reads: 4, writes: 1, indexOperations: 2, transactions: 1 };
  const measuredOps = { reads: 30, writes: 30, indexOperations: 0, transactions: 0 };
  const result = coverageBenchmarkResult(30, { coverageOperations: 30,
    latency: { samples: 30, p50Ms: 1, p95Ms: 2, p99Ms: 3 },
    memory: { heapUsedBeforeBytes: 0, heapUsedAfterBytes: 0, peakHeapUsedBytes: 0, rssAfterBytes: 0 } },
  measuredOps, setup, 'streamId_1_commitSequence_1');
  expect(result).toMatchObject({ scenario: 'transport_coverage_synthetic_cas',
    parameters: { sourceBacked: 'false', coverageBasis: 'standalone_synthetic_order_port_cas' },
    logicalOperations: 30, coverageOperations: 30, databaseOperations: measuredOps,
    setup: { baselineRegistrations: 1, sourceRows: 0, indexedHighWatermark: -1,
      databaseIndexOperations: 2, databaseTransactions: 1 } });
});
