#!/usr/bin/env node

const { execFileSync } = require('node:child_process');
const { mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');

const repoRoot = resolve(__dirname, '..');
const temporaryDirectory = mkdtempSync(join(tmpdir(), 'redemeine-projection-consumer-'));

function run(command, argumentsList, options = {}) {
  execFileSync(command, argumentsList, { stdio: 'inherit', ...options });
}

function pack(packageDirectory) {
  run('pnpm', ['pack', '--pack-destination', temporaryDirectory], { cwd: packageDirectory });
}

try {
  const projectionDirectory = join(repoRoot, 'packages/projection');
  const runtimeDirectory = join(repoRoot, 'packages/projection-runtime-core');
  pack(projectionDirectory);
  pack(runtimeDirectory);

  const tarballs = readdirSync(temporaryDirectory)
    .filter((name) => name.endsWith('.tgz'))
    .map((name) => join(temporaryDirectory, name));
  const immerDirectory = realpathSync(join(runtimeDirectory, 'node_modules/immer'));
  run('npm', [
    'install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false',
    ...tarballs, immerDirectory
  ], { cwd: temporaryDirectory });

  writeFileSync(join(temporaryDirectory, 'package.json'), JSON.stringify({ type: 'module' }));
  writeFileSync(join(temporaryDirectory, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      strict: true,
      noEmit: true,
      exactOptionalPropertyTypes: true,
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      target: 'ES2022',
      skipLibCheck: false
    },
    files: ['consumer.ts']
  }));
  writeFileSync(join(temporaryDirectory, 'consumer.ts'), `
import { createProjection } from '@redemeine/projection';
import {
  projectionUuidToBase64Url22,
  type ProjectionNoCommitProgress,
  type ProjectionSourceCheckpoint,
  type ProjectionSourceCommitStorePort
} from '@redemeine/projection-runtime-core';

const aggregate = { aggregateType: 'sample', pure: { eventProjectors: { changed: () => undefined } } };
const definition = createProjection('sample', () => ({}))
  .from(aggregate, {})
  .deduplication({ strategy: 'own_record' })
  .buildCommitDefinition();
const checkpoint: ProjectionSourceCheckpoint | null = { sequence: 0 };
const sourceKey = projectionUuidToBase64Url22('00112233-4455-6677-8899-aabbccddeeff');
declare const store: ProjectionSourceCommitStorePort;
void [definition, checkpoint, sourceKey, store];

// @ts-expect-error none requires explicit duplicate-effects acknowledgement
createProjection('unsafe', () => ({})).deduplication({ strategy: 'none', reason: 'unsafe' });
// @ts-expect-error commit identity belongs to the envelope, not projection checkpoints
const invalidCheckpoint: ProjectionSourceCheckpoint = { sequence: 0, commitId: 'not-allowed' };
// @ts-expect-error none carries no projection dedupe checkpoint payload
const invalidNone = { strategy: 'none', source: { finalSequence: 0 } } satisfies ProjectionNoCommitProgress;
void [invalidCheckpoint, invalidNone];
`);

  const tsc = join(runtimeDirectory, 'node_modules/typescript/bin/tsc');
  run(process.execPath, [tsc, '-p', join(temporaryDirectory, 'tsconfig.json')]);
  console.log('✅ Installed projection contract consumer compiled successfully.');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
