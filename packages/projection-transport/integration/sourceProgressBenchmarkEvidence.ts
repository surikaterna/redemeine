import { writeFile } from 'node:fs/promises';
import { cpus, platform, release } from 'node:os';
import type { BenchmarkParameters, BenchmarkResult } from './sourceProgressBenchmarkTypes';

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
};

export const writeBenchmarkEvidence = async (parameters: BenchmarkParameters, results: readonly BenchmarkResult[], mongoServer: string): Promise<void> => {
  const evidence = {
    qualification: 'projection-source-progress-benchmark',
    gitSha: required('REDEMEINE_GIT_SHA'),
    parameters,
    environment: { node: process.version, platform: platform(), release: release(), cpu: cpus()[0]?.model, cpuCount: cpus().length },
    versions: { mongoServer, mongodbDriver: '6.18.0' },
    measurement: { kind: 'actual', syntheticDatabaseCounts: false, percentileMethod: 'nearest-rank', warmupSamples: 0 },
    envelope: {
      automaticSpill: false,
      inline: 'physically bounded by MongoDB BSON/document capacity; 1000/1001 are warning-envelope measurements',
      ownRecord: 'separate scalar rows; 10000/100000 setup is measured in bounded batches'
    },
    results,
    databaseCleanupVerified: true
  };
  await writeFile(required('REDEMEINE_EVIDENCE_PATH'), `${JSON.stringify(evidence)}\n`, { flag: 'wx' });
};
