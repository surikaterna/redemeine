import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { audit } from '../check.mjs';
import { qualify } from '../consumer.mjs';
import { createHandoff } from '../handoff.mjs';
import { createPlan } from '../release-plan.mjs';
import { repo } from '../test/fixtures.mjs';
import { hash } from '../workspace.mjs';
import { greenFixture } from './fixtures.mjs';

const { values } = parseArgs({ options: { mode: { type: 'string' }, output: { type: 'string' } }, allowPositionals: false });
if (!['healthy-fixture', 'repository-plan'].includes(values.mode) || !values.output?.startsWith('/tmp/'))
  throw new Error('Fixed mode and fresh /tmp output required');
await mkdir(values.output);
const removals = [];
try {
  if (values.mode === 'repository-plan') {
    const planned = await createPlan(repo, { intent: resolve(repo, 'scripts/release/release-intent.json'), output: resolve(values.output, 'plan') });
    const global = resolve(values.output, 'global');
    const aCode = await audit(repo, { output: global });
    const manifest = resolve(global, 'manifest.json');
    const b = await qualify({ manifest, 'manifest-sha256': hash(await readFile(manifest)), output: resolve(values.output, 'b'), root: [] });
    await writeFile(resolve(values.output, 'blocked.json'), JSON.stringify({ plan: planned.exitCode, a: aCode, b: b.exitCode, livePublishing: false }));
    process.exitCode = 2;
  } else {
    const fixture = await greenFixture({ after: (callback) => removals.push(callback) }, 'pre');
    const manifest = resolve(fixture.a.output, 'manifest.json');
    const aSha = hash(await readFile(manifest));
    const bOutput = resolve(fixture.directory, 'b');
    const b = await qualify(
      { manifest, 'manifest-sha256': aSha, output: bOutput, root: [] },
      await readFile(resolve(fixture.root, 'scripts/release/policy.json'))
    );
    if (b.exitCode !== 0) throw new Error(`Genuine fixture B failed: ${b.exitCode}; ${bOutput}`);
    const global = resolve(fixture.globalOutput, 'manifest.json');
    const output = resolve(values.output, 'bundle');
    const handoff = await createHandoff({
      plan: fixture.planPath,
      'plan-sha256': fixture.sha256,
      manifest,
      'manifest-sha256': aSha,
      'consumer-result': resolve(bOutput, 'result.json'),
      'consumer-sha256': hash(await readFile(resolve(bOutput, 'result.json'))),
      'global-manifest': global,
      'global-sha256': hash(await readFile(global)),
      output
    });
    await cp(fixture.directory, resolve(values.output, 'producer-evidence'), { recursive: true });
    // This workflow-only process is never a cached Turbo task.
    // biome-ignore lint/suspicious/noUndeclaredEnvVars: GitHub's per-step output protocol, not a build dependency.
    const githubOutput = process.env.GITHUB_OUTPUT;
    if (githubOutput) await writeFile(githubOutput, `envelope-sha256=${handoff.sha256}\n`, { flag: 'a' });
  }
} finally {
  for (const cleanup of removals) await cleanup();
}
