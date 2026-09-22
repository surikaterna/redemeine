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
import {
  createProjection,
  inherit,
  type InheritExtended,
  type MirrorableAggregateSource,
  type ProjectionContext,
  type ProjectionEvent
} from '@redemeine/projection';
import {
  projectionUuidToBase64Url22,
  validateProjectionQueueRegistryManifest,
  type ProjectionNoCommitProgress,
  type ProjectionCompleteCommitRangeRequest,
  type ProjectionQueueRegistryManifest,
  type ProjectionSourceCheckpoint,
  type ProjectionSourceCommitStorePort
} from '@redemeine/projection-runtime-core';

const aggregate = { aggregateType: 'sample', pure: { eventProjectors: { changed: () => undefined } } };
const definition = createProjection('sample', () => ({}))
  .from(aggregate, {})
  .deduplication({ strategy: 'own_record' })
  .buildCommitDefinition();
type MirrorState = { count: number };
type ChangedEvent = Omit<ProjectionEvent, 'payload' | 'type'> & {
  payload: { amount: number };
  type: 'changed' | 'sample.changed.event';
};
const extended: InheritExtended<MirrorState, ChangedEvent> = inherit.extend((state, event) => {
  state.count += event.payload.amount;
});
const mirrorSource = {
  aggregateType: 'sample' as const,
  initialState: { count: 0 },
  pure: { eventProjectors: { changed: (_state: MirrorState, _event: ChangedEvent) => undefined } },
  applyToDraft(state: MirrorState, event: ChangedEvent) { state.count += event.payload.amount; }
} satisfies MirrorableAggregateSource<MirrorState, ChangedEvent>;
const changedEvent: ChangedEvent = {
  aggregateType: 'sample', aggregateId: 'one', type: 'sample.changed.event', payload: { amount: 1 },
  sequence: 1, timestamp: '2024-01-01T00:00:00Z'
};
mirrorSource.applyToDraft(mirrorSource.initialState, changedEvent);
const unparameterizedMirror: MirrorableAggregateSource = mirrorSource;
const mirrored = createProjection('mirror').mirror(mirrorSource, { changed: extended }).build();
const checkpoint: ProjectionSourceCheckpoint | null = { sequence: 0 };
const sourceKey = projectionUuidToBase64Url22('00112233-4455-6677-8899-aabbccddeeff');
const digest = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as const;
const rangeRequest: ProjectionCompleteCommitRangeRequest = {
  sourceId: '00112233-4455-6677-8899-aabbccddeeff',
  afterSequence: null,
  throughSequence: 0,
  maxCommits: 10,
  maxBytes: 1_048_576
};
const manifest: ProjectionQueueRegistryManifest = {
  version: 1,
  manifestId: digest,
  queueId: 'projection-v1',
  registryGeneration: 'v1',
  identity: {
    version: 1,
    normalizedDefinitionRegistryDigest: digest,
    normalizedRuntimeConfigurationDigest: digest,
    executableCodeArtifactDigest: digest
  },
  definitions: [],
  sourceStartAnchors: {}
};
validateProjectionQueueRegistryManifest(manifest);
declare const store: ProjectionSourceCommitStorePort;
void [definition, unparameterizedMirror, mirrored, checkpoint, sourceKey, rangeRequest, manifest, store];

declare const context: ProjectionContext;
declare const defaultOnly: InheritExtended;
defaultOnly.after({ count: 0 }, changedEvent, context);
extended.after({ count: 0 }, changedEvent, context);
// @ts-expect-error explicitly typed extensions reject callbacks with incompatible state
const wrongExtended: InheritExtended<MirrorState, ChangedEvent> = inherit.extend((_state: { wrong: boolean }, _event: ChangedEvent) => {});
// @ts-expect-error mirror sources retain their declared event payload
mirrorSource.applyToDraft({ count: 0 }, { ...changedEvent, payload: { amount: 'invalid' } });
type WideEvent = Omit<ChangedEvent, 'payload'> & { payload: { amount: number | string } };
// @ts-expect-error a narrow event mutator cannot be assigned where wider events may be supplied
const unsafeWideEventSource: MirrorableAggregateSource<MirrorState, WideEvent> = mirrorSource;
type NarrowState = { count: 0 };
// @ts-expect-error state appears in input and output positions and is invariant
const unsafeNarrowStateSource: MirrorableAggregateSource<NarrowState, ChangedEvent> = mirrorSource;
// @ts-expect-error handler event payload remains inferred from the source projector
createProjection('bad-handler', () => ({ count: 0 })).from(mirrorSource, { changed: (_state, event) => event.payload.missing });
// @ts-expect-error none requires explicit duplicate-effects acknowledgement
createProjection('unsafe', () => ({})).deduplication({ strategy: 'none', reason: 'unsafe' });
// @ts-expect-error commit identity belongs to the envelope, not projection checkpoints
const invalidCheckpoint: ProjectionSourceCheckpoint = { sequence: 0, commitId: 'not-allowed' };
// @ts-expect-error none carries no projection dedupe checkpoint payload
const invalidNone = { strategy: 'none', source: { finalSequence: 0 } } satisfies ProjectionNoCommitProgress;
// @ts-expect-error bounded complete-range reads require an explicit byte limit
const unboundedRange: ProjectionCompleteCommitRangeRequest = {
  sourceId: '00112233-4455-6677-8899-aabbccddeeff', afterSequence: null, throughSequence: 0, maxCommits: 10
};
// @ts-expect-error immutable manifests require normalized config and executable artifact identity
const unboundManifest: ProjectionQueueRegistryManifest = {
  version: 1, manifestId: digest, queueId: 'q', registryGeneration: 'v1', definitions: [], sourceStartAnchors: {}
};
// @ts-expect-error selectors remain a normalized string array
const invalidSelectors: ProjectionQueueRegistryManifest = { ...manifest, definitions: [{ projectionName: 'p', generation: 'v1', definitionHash: digest, sourceSelectors: null }] };
// @ts-expect-error source anchors remain a UUID-to-sequence record
const invalidAnchors: ProjectionQueueRegistryManifest = { ...manifest, sourceStartAnchors: [] };
void [wrongExtended, unsafeWideEventSource, unsafeNarrowStateSource, invalidCheckpoint, invalidNone, unboundedRange, unboundManifest, invalidSelectors, invalidAnchors];
`);

  writeFileSync(join(temporaryDirectory, 'runtime.mjs'), `
import { validateProjectionQueueRegistryManifest } from '@redemeine/projection-runtime-core';
const digest = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const issues = validateProjectionQueueRegistryManifest({
  version: 1,
  manifestId: digest,
  queueId: 'q',
  registryGeneration: 'v1',
  identity: {
    version: 1,
    normalizedDefinitionRegistryDigest: digest,
    normalizedRuntimeConfigurationDigest: digest,
    executableCodeArtifactDigest: digest
  },
  definitions: [{
    projectionName: 'p', generation: 'v1', definitionHash: digest, sourceSelectors: [' invoice ', 'invoice']
  }],
  sourceStartAnchors: []
});
if (!issues.includes('definitions[0].sourceSelectors[0].normalized')
  || !issues.includes('definitions[0].sourceSelectors[1].duplicate')
  || !issues.includes('sourceStartAnchors')) process.exit(1);
`);

  const tsc = join(runtimeDirectory, 'node_modules/typescript/bin/tsc');
  run(process.execPath, [tsc, '-p', join(temporaryDirectory, 'tsconfig.json')]);
  run(process.execPath, [join(temporaryDirectory, 'runtime.mjs')]);
  console.log('✅ Installed projection contract consumer compiled successfully.');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
