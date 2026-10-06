import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('documented and workflow root interfaces target the actual nonpublishing entrypoints', async () => {
  const { scripts } = JSON.parse(await readFile(new URL('../../../package.json', import.meta.url), 'utf8'));
  assert.equal(scripts['release:plan'], 'node scripts/release/release-plan.mjs');
  assert.equal(scripts['release:handoff'], 'node scripts/release/handoff.mjs');
  assert.equal(scripts['release:rehearse'], 'node scripts/release/publish-rehearsal.mjs');
});

test('C4.15 legacy event escape removed; cross-job workflow read-only, immutable IDs and digest admission', async () => {
  const legacy = await readFile(new URL('../../../.github/workflows/publish.yml', import.meta.url), 'utf8');
  assert.match(legacy, /workflow_dispatch:/);
  assert.match(legacy, /exit 1/);
  assert.doesNotMatch(legacy, /release:|published|secrets\.|id-token|registry-url|pnpm.*publish/);
  const workflow = await readFile(new URL('../../../.github/workflows/release-handoff-rehearsal.yml', import.meta.url), 'utf8');
  assert.doesNotMatch(workflow, /secrets\.|id-token|contents: write|pull_request_target|continue-on-error/);
  for (const match of workflow.matchAll(/uses: ([^\n]+)/g)) assert.match(match[1], /@[a-f0-9]{40}/);
  assert.match(workflow, /artifact-ids: \$\{\{ needs.producer.outputs.artifact-id \}\}/);
  assert.match(workflow, /--envelope-sha256 "\$EXPECTED_ENVELOPE"/);
  assert.match(workflow, /cancel-in-progress: false/);
  const consumer = workflow.slice(workflow.indexOf('\n  consumer:'));
  assert.doesNotMatch(consumer, /turbo run build|release:check|pnpm.* pack/);
  assert.match(consumer, /if: always\(\)/);
});
