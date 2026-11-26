#!/usr/bin/env node

const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const { mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');

const repoRoot = resolve(__dirname, '..');
const temporaryDirectory = realpathSync(mkdtempSync(join(tmpdir(), 'redemeine-projection-consumer-')));

function run(command, argumentsList, options = {}) {
  execFileSync(command, argumentsList, { stdio: 'inherit', ...options });
}

function pack(packageDirectory) {
  run('pnpm', ['pack', '--pack-destination', temporaryDirectory], { cwd: packageDirectory });
}

function checkTypes(tsc, consumer, declaration) {
  writeFileSync(join(temporaryDirectory, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      strict: true,
      noEmit: true,
      exactOptionalPropertyTypes: true,
      noUncheckedIndexedAccess: true,
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      target: 'ES2022',
      skipLibCheck: false,
      types: []
    },
    files: [consumer]
  }));
  const result = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.json', '--listFiles'], {
    cwd: temporaryDirectory,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit']
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stdout);
  assert.ok(
    result.stdout.split(/\r?\n/).map((file) => resolve(file)).includes(join(temporaryDirectory, 'node_modules/@redemeine/projection/dist', declaration)),
    `${consumer} did not load the installed ${declaration}`
  );
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
  writeFileSync(join(temporaryDirectory, 'consumer.mts'), `
import {
  createProjection,
  inherit,
  type InheritExtended,
  type MirrorableAggregateSource,
  type ProjectionBuilder as PublicBuilder,
  type ProjectionCommitBuilder,
  type ProjectionCommitDefinition as PublicCommitDefinition,
  type ProjectionContext,
  type ProjectionEvent
} from '@redemeine/projection';
import {
  createProjection as createRuntimeProjection,
  projectionUuidToBase64Url22,
  validateProjectionQueueRegistryManifest,
  type ProjectionNoCommitProgress,
  type ProjectionBuilder as RuntimeBuilder,
  type ProjectionCommitDefinition as RuntimeCommitDefinition,
  type ProjectionCompleteCommitRangeRequest,
  type ProjectionQueueRegistryManifest,
  type ProjectionSourceCheckpoint,
  type ProjectionSourceCommitStorePort
} from '@redemeine/projection-runtime-core';

const aggregate = { aggregateType: 'sample', pure: { eventProjectors: { changed: () => undefined } } };
type ReadonlyView = { readonly metadata: { readonly timestamps: readonly string[] } };
const initialView = (): ReadonlyView => ({ metadata: { timestamps: [] } });
createProjection('public-hook', initialView).hooks({
  afterEach(draft, event) { draft.metadata.timestamps.push(event.timestamp); }
});
createRuntimeProjection('core-hook', initialView).hooks({
  afterEach(draft, event) { draft.metadata.timestamps.push(event.timestamp); }
});
const definition = createProjection('sample', () => ({}))
  .deduplication({ strategy: 'own_record' })
  .from(aggregate, {})
  .hooks({})
  .initialState(() => ({}))
  .identity((event) => event.aggregateId)
  .build() satisfies PublicCommitDefinition<{}>;
const joinSource = { ...aggregate, aggregateType: 'joined' };
const runtimeBuilder = createRuntimeProjection('sample', () => ({}))
  .deduplication({ strategy: 'own_record' })
  .from(aggregate, {})
  .join(joinSource, { changed: () => {} })
  .joinRight(joinSource, { changed: (event) => event.aggregateId })
  .reverseSubscribe({ ...aggregate, aggregateType: 'other' }, {})
  .initialState(() => ({}))
  .hooks({})
  .identity((event) => event.aggregateId);
const runtimeDefinition = runtimeBuilder.build() satisfies RuntimeCommitDefinition<{}>;
const alias = runtimeBuilder.buildCommitDefinition() satisfies RuntimeCommitDefinition<{}>;
const coreAsBuilder: RuntimeBuilder<{}> = runtimeBuilder;
// @ts-expect-error A public build without explicit deduplication is not commit-native.
const legacyPublic: PublicCommitDefinition<{}> = createProjection('legacy', () => ({})).from(aggregate, {}).build();
// @ts-expect-error The runtime builder has the same distinction.
const legacyRuntime: RuntimeCommitDefinition<{}> = createRuntimeProjection('legacy', () => ({})).from(aggregate, {}).build();
// @ts-expect-error The compatibility alias is only typed on the explicit-dedupe stage.
createProjection('legacy', () => ({})).from(aggregate, {}).buildCommitDefinition();
type MirrorState = { count: number };
type NarrowState = { count: 0 };
type ChangedEvent = Omit<ProjectionEvent, 'payload' | 'type'> & {
  payload: { amount: number };
  type: 'changed' | 'sample.changed.event';
};
const extended: InheritExtended<MirrorState, ChangedEvent> = inherit.extend((state, event) => {
  state.count += event.payload.amount;
});
const defaultExtended: InheritExtended = inherit.extend((state: MirrorState, event: ChangedEvent) => {
  state.count += event.payload.amount;
});
const stateExtended: InheritExtended<MirrorState> = inherit.extend((state: MirrorState, event: ChangedEvent) => {
  state.count += event.payload.amount;
});
const supertypeStateExtended: InheritExtended<NarrowState> = inherit.extend((state: MirrorState, event: ChangedEvent) => {
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
const commitMirrorBuilder: ProjectionCommitBuilder<MirrorState> = createProjection('mirror')
  .deduplication({ strategy: 'own_record' })
  .mirror(mirrorSource)
  .join(joinSource, { changed: (state) => { state.count++; } })
  .joinRight(joinSource, { changed: (event) => [event.aggregateId] });
const commitMirror = commitMirrorBuilder.build() satisfies PublicCommitDefinition<MirrorState>;
const commitMirrorAlias = commitMirrorBuilder.buildCommitDefinition() satisfies PublicCommitDefinition<MirrorState>;
const publicAsBuilder: PublicBuilder<MirrorState> = commitMirrorBuilder;
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
void [definition, runtimeDefinition, alias, legacyPublic, legacyRuntime, commitMirror, commitMirrorAlias, coreAsBuilder, publicAsBuilder,
  defaultExtended, stateExtended, supertypeStateExtended, unparameterizedMirror, mirrored, checkpoint, sourceKey, rangeRequest, manifest, store];

declare const context: ProjectionContext;
declare const defaultOnly: InheritExtended;
defaultOnly.after({ count: 0 }, changedEvent, context);
stateExtended.after({ count: 0 }, changedEvent, context);
extended.after({ count: 0 }, changedEvent, context);
// @ts-expect-error partial generics retain the explicit state contract
const wrongPartialState: InheritExtended<MirrorState> = inherit.extend((_state: { wrong: boolean }, _event: ChangedEvent) => {});
// @ts-expect-error an explicit partial state rejects a callback accepting only a related narrower state
const unsafePartialNarrowState: InheritExtended<MirrorState> = inherit.extend((_state: NarrowState, _event: ChangedEvent) => {});
// @ts-expect-error partial generic invocation retains the explicit state contract
stateExtended.after({ wrong: true }, changedEvent, context);
// @ts-expect-error explicitly typed extensions reject callbacks with incompatible state
const wrongExtended: InheritExtended<MirrorState, ChangedEvent> = inherit.extend((_state: { wrong: boolean }, _event: ChangedEvent) => {});
type WrongChangedEvent = Omit<ChangedEvent, 'payload'> & { payload: { amount: string } };
// @ts-expect-error fully explicit extensions reject callbacks with incompatible events
const wrongExplicitEvent: InheritExtended<MirrorState, ChangedEvent> = inherit.extend((_state: MirrorState, _event: WrongChangedEvent) => {});
// @ts-expect-error mirror sources retain their declared event payload
mirrorSource.applyToDraft({ count: 0 }, { ...changedEvent, payload: { amount: 'invalid' } });
type WideEvent = Omit<ChangedEvent, 'payload'> & { payload: { amount: number | string } };
// @ts-expect-error a narrow event mutator cannot be assigned where wider events may be supplied
const unsafeWideEventSource: MirrorableAggregateSource<MirrorState, WideEvent> = mirrorSource;
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
void [wrongPartialState, unsafePartialNarrowState, wrongExtended, wrongExplicitEvent, unsafeWideEventSource, unsafeNarrowStateSource, invalidCheckpoint, invalidNone, unboundedRange, unboundManifest, invalidSelectors, invalidAnchors];
`);

  writeFileSync(join(temporaryDirectory, 'consumer.cts'), `
import projection = require('@redemeine/projection');
const definition: projection.ProjectionDefinition<{ count: number }> =
  projection.createProjection('cjs', () => ({ count: 0 })).build();
definition.initialState('one').count.toFixed();
// @ts-expect-error The CommonJS builder retains the inferred state.
projection.createProjection('cjs', () => ({ count: 0 })).build().initialState('one').count.toUpperCase();
`);

  writeFileSync(join(temporaryDirectory, 'runtime.mjs'), `
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createProjection } from '@redemeine/projection';
import { validateProjectionQueueRegistryManifest } from '@redemeine/projection-runtime-core';

const name = '@redemeine/projection';
const require = createRequire(import.meta.url);
const dist = new URL('./node_modules/@redemeine/projection/dist/', import.meta.url);
assert.equal(import.meta.resolve(name), new URL('index.js', dist).href);
assert.equal(require.resolve(name), fileURLToPath(new URL('index.cjs', dist)));
for (const create of [createProjection, require(name).createProjection]) {
  const projection = create('packed-view', (id) => ({ id, count: 0 }))
    .from({ aggregateType: 'counter', pure: { eventProjectors: {} } }, {
      incremented: (state) => { state.count += 1; }
    })
    .build();
  const state = projection.initialState('one');
  projection.fromStream.handlers.incremented(state, { type: 'incremented', payload: {} }, {});
  assert.deepEqual(state, { id: 'one', count: 1 });
}

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
  checkTypes(tsc, 'consumer.mts', 'index.d.ts');
  checkTypes(tsc, 'consumer.cts', 'index.d.cts');
  run(process.execPath, [join(temporaryDirectory, 'runtime.mjs')]);
  console.log('✅ Installed projection ESM/CJS and runtime-core contract checks passed.');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
