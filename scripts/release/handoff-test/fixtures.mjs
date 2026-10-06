import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { audit } from '../check.mjs';
import { createPlan } from '../release-plan.mjs';
import { canonicalBytes } from '../release-plan-schema.mjs';
import { manifest, policy, put, repo, workspace } from '../test/fixtures.mjs';

export async function plannedFixture(t, channel = 'stable', prepare = async () => {}) {
  const version = channel === 'pre' ? '1.0.0-pre.1' : '1.0.0';
  const selectedPolicy = { ...policy, holds: { '@fixture/held': { owner: 'test', reason: 'Private dependency; excluded before A' } } };
  const trap = "node -e \"require('node:fs').writeFileSync('LIFECYCLE_RAN','unexpected')\"";
  const scripts = Object.fromEntries(['prepack', 'prepare', 'postpack', 'prepublishOnly', 'publish', 'postpublish', 'install'].map((name) => [name, trap]));
  const fixture = await workspace(
    [
      manifest('@fixture/base', { version, scripts }),
      manifest('@fixture/app', { version, scripts, dependencies: { '@fixture/base': version } }),
      manifest('@fixture/held', { dependencies: { '@fixture/private': '1.0.0' } }),
      manifest('@fixture/private', { private: true })
    ],
    selectedPolicy
  );
  const output = await mkdtemp(resolve(tmpdir(), 'handoff-fixture-'));
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  await put(resolve(fixture.root, 'scripts/release/consumer-tools.json'), await readFile(resolve(repo, 'scripts/release/consumer-tools.json')));
  await put(resolve(fixture.root, '.changeset/config.json'), {
    $schema: 'https://unpkg.com/@changesets/config@2.3.1/schema.json',
    changelog: false,
    commit: false,
    fixed: [],
    linked: [],
    access: 'public',
    baseBranch: 'HEAD',
    updateInternalDependencies: 'patch',
    ignore: []
  });
  if (channel === 'pre') await put(resolve(fixture.root, '.changeset/pre.json'), { mode: 'pre', tag: 'pre', initialVersions: {}, changesets: [] });
  await put(resolve(fixture.root, '.changeset/fixture-control.md'), '---\n---\n\nDisposable fixture only.\n');
  const intent = {
    schemaVersion: 1,
    actor: 'generated disposable fixture',
    channel,
    destinationTag: channel === 'pre' ? 'pre' : 'latest',
    selected: [
      { name: '@fixture/base', version },
      { name: '@fixture/app', version }
    ],
    candidateEdges: [{ from: '@fixture/app', field: 'dependencies', name: '@fixture/base', version }],
    exclusions: {
      'fixture-root': { held: true, reason: 'Private' },
      'fixture-website': { held: true, reason: 'Private' },
      '@fixture/private': { held: true, reason: 'Private' },
      '@fixture/held': { held: true, reason: 'Held broken sibling' }
    },
    changesets: { 'fixture-control': 'Fixture-only empty intent; no repository changeset consumption' }
  };
  const context = { ...fixture, directory: output, intent, version };
  await prepare(context);
  await put(resolve(fixture.root, 'intent.json'), canonicalBytes(intent));
  const planned = await createPlan(fixture.root, { intent: resolve(fixture.root, 'intent.json'), output: resolve(output, 'plan') }, fixture.registry);
  return { ...context, ...planned, planPath: resolve(output, 'plan/plan.json') };
}

export async function scopedAudit(fixture) {
  const output = resolve(fixture.directory, 'a');
  const code = await audit(fixture.root, {
    output,
    'registry-fixture': fixture.registry,
    'release-plan': fixture.planPath,
    'release-plan-sha256': fixture.sha256
  });
  const manifest = JSON.parse(await readFile(resolve(output, 'manifest.json'), 'utf8'));
  return { output, code, manifest };
}

export async function greenFixture(t, channel = 'stable', prepare = undefined) {
  const fixture = await plannedFixture(t, channel, prepare);
  assert.equal(fixture.exitCode, 0);
  const a = await scopedAudit(fixture);
  assert.equal(a.code, 0, JSON.stringify(a.manifest.diagnostics));
  const globalOutput = resolve(fixture.directory, 'global');
  assert.equal(await audit(fixture.root, { output: globalOutput, 'registry-fixture': fixture.registry }), 1);
  return { ...fixture, a, globalOutput };
}
