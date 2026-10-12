import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { imageMetadata } from '../scripts/projection-image-metadata.mjs';

const base = { EVENT_NAME: 'release', RELEASE_TAG: 'projection-runtime-v0.1.0-rc.1', GITHUB_REPOSITORY: 'Surikaterna/Redemeine', SOURCE_SHA: 'a'.repeat(40) };

test('release prefix, lowercase repository and checked-out SHA identify one image', () => {
  assert.deepEqual(imageMetadata(base), {
    image: 'ghcr.io/surikaterna/redemeine-projection-runtime',
    version: '0.1.0-rc.1',
    sha: 'a'.repeat(40),
    short_sha: 'a'.repeat(12)
  });
});

test('manual version is explicit and independent of the private package version', () => {
  assert.equal(imageMetadata({ ...base, EVENT_NAME: 'workflow_dispatch', IMAGE_VERSION: '0.1.0-rc.2' }).version, '0.1.0-rc.2');
});

test('unsafe or unsupported versions, events, repositories and SHAs refuse', () => {
  for (const version of ['', 'latest', 'v0.1.0', '0.1.0+meta', '0.1.0\n', '0.1.0\nimage=evil', '$(id)', '0.1.0/rc', '1'.repeat(129), '0.1.0-']) {
    assert.throws(() => imageMetadata({ ...base, RELEASE_TAG: `projection-runtime-v${version}` }));
    assert.throws(() => imageMetadata({ ...base, EVENT_NAME: 'workflow_dispatch', IMAGE_VERSION: version }));
  }
  for (const patch of [
    { EVENT_NAME: 'pull_request' },
    { RELEASE_TAG: 'v0.1.0' },
    { IMAGE_VERSION: undefined, EVENT_NAME: 'workflow_dispatch' },
    { GITHUB_REPOSITORY: 'owner/repo\nevil' },
    { GITHUB_REPOSITORY: '../repo' },
    { SOURCE_SHA: 'a'.repeat(40) + '\n' },
    { SOURCE_SHA: 'abc' }
  ]) {
    assert.throws(() => imageMetadata({ ...base, ...patch }));
  }
});

test('workflow validates before login and publishes only root-context main image', () => {
  const workflow = readFileSync(new URL('../workflows/projection-image.yml', import.meta.url), 'utf8');
  assert.ok(workflow.indexOf('node .github/scripts/projection-image-metadata.mjs') < workflow.indexOf('docker/login-action'));
  assert.match(workflow, /types: \[published\]/u);
  assert.match(workflow, /context: \.\n\s+file: packages\/projection-service\/Dockerfile/u);
  assert.match(workflow, /platforms: linux\/amd64/u);
  assert.doesNotMatch(workflow, /pull_request|contents: write|:latest|Projection\.Dockerfile|pnpm.*publish/u);
  assert.doesNotMatch(
    workflow
      .split('run:')
      .slice(1)
      .map((part) => part.split('\n      -')[0])
      .join(''),
    /\$\{\{/u
  );
});

test('CLI writes validated outputs only; npm workflow stays byte-identical', () => {
  const directory = mkdtempSync('/tmp/opencode/projection-image-metadata-');
  const output = `${directory}/output`;
  const script = new URL('../scripts/projection-image-metadata.mjs', import.meta.url);
  try {
    writeFileSync(output, '');
    const env = { ...process.env, ...base, GITHUB_OUTPUT: output };
    assert.equal(spawnSync(process.execPath, [script.pathname], { env }).status, 0);
    const expected = Object.entries(imageMetadata(base))
      .map(([key, value]) => `${key}=${value}\n`)
      .join('');
    assert.equal(readFileSync(output, 'utf8'), expected);
    assert.notEqual(
      spawnSync(process.execPath, [script.pathname], {
        env: { ...env, RELEASE_TAG: 'projection-runtime-v0.1.0\nimage=evil' }
      }).status,
      0
    );
    assert.equal(readFileSync(output, 'utf8'), expected);
    const publisher = readFileSync(new URL('../workflows/publish.yml', import.meta.url));
    assert.equal(createHash('sha256').update(publisher).digest('hex'), 'c85ceff42da7f74f9e0d9bd10a513688eb9879efa3eb187532575238b48d9911');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
