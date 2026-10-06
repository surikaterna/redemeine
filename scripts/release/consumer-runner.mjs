import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createContainer, docker, inspectOwned } from './consumer-docker.mjs';
import { artifactKey } from './consumer-graph.mjs';
import { ConsumerError, demand } from './consumer-schema.mjs';
import { smokePlan } from './consumer-smokes.mjs';
import { hash } from './workspace.mjs';

export function planConsumers(input, selection) {
  return selection.roots.map((root) => ({ root, smoke: smokePlan(input.artifacts.find((a) => artifactKey(a) === root)) }));
}

export async function runConsumers(state, input, selection, registry, images, plans) {
  state.report.consumers = [];
  let outcome = 0;
  for (const image of images) {
    for (const plan of plans) outcome = Math.max(outcome, await consumerOutcome(state, input, selection, registry, image, plan));
  }
  demand(outcome === 0, 'Consumer matrix did not fully qualify; all runtime/root outcomes retained', outcome);
}

async function consumerOutcome(state, input, selection, registry, image, plan) {
  try {
    await runConsumer(state, input, selection, registry, image, [plan]);
    return 0;
  } catch (error) {
    if (error.code === 2 && error.kind === 'coverage-incomplete') return 2;
    if (error.code !== 1) throw error;
    return 1;
  }
}

export async function runConsumer(state, input, selection, registry, image, plans) {
  const index = state.report.consumers.length;
  const directory = resolve(state.output, `consumer-input-${index}`);
  await mkdir(directory, { mode: 0o700 });
  const job = {
    endpoint: registry.endpoint,
    roots: plans.map((p) => p.root),
    smokes: plans.map((p) => p.smoke),
    graph: input.graph.edges,
    owned: input.graph.owned,
    artifacts: input.artifacts
      .filter((a) => selection.order.includes(artifactKey(a)))
      .map((a) => ({ manifest: a.manifest, sha256: a.sha256, integrity: a.integrity }))
  };
  await writeFile(resolve(directory, 'job.json'), JSON.stringify(job), { mode: 0o600 });
  for (const file of ['consume.mjs', 'verify.mjs', 'smoke.mjs', 'declarations.mjs', 'cli-generation.mjs']) {
    await copyFile(new URL(`./consumer-runtime/${file}`, import.meta.url), resolve(directory, file));
  }
  const id = await createContainer(state, image.id, registry.internal, ['--entrypoint', 'node'], ['/job/consume.mjs']);
  await docker(['cp', directory, `${id}:/job`]);
  const identity = await inspectOwned(state, id, registry.internal, image.id);
  await docker(['start', id]);
  await docker(['wait', id], 240000);
  const receipt = resolve(state.output, `consumer-${index}.json`);
  await docker(['cp', `${id}:/job/result.json`, receipt]);
  const result = JSON.parse(await readFile(receipt, 'utf8'));
  state.report.consumers.push({ ...result, identity, receiptSha256: hash(await readFile(receipt)) });
  if (result.lockSha256) await docker(['cp', `${id}:/job/package-lock.json`, resolve(state.output, `consumer-${index}-lock.json`)]);
  if (result.generatedSha256) await docker(['cp', `${id}:/job/generated.ts`, resolve(state.output, `consumer-${index}-generated.ts`)]);
  if (result.cliSourceSha256) await docker(['cp', `${id}:/job/aggregate.ts`, resolve(state.output, `consumer-${index}-aggregate.ts`)]);
  await rm(directory, { recursive: true, force: true });
  if (result.exitCode !== 0) throw Object.assign(new ConsumerError(result.exitCode, 'Consumer failed; see per-root receipt'), { kind: result.failureKind });
}
