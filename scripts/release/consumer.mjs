import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { cleanup, dockerRun, provision, tools, withDockerSignal } from './consumer-docker.mjs';
import { noLinks } from './consumer-files.mjs';
import { selectRoots } from './consumer-graph.mjs';
import { loadInput } from './consumer-input.mjs';
import { planConsumers, runConsumers } from './consumer-runner.mjs';
import { demand } from './consumer-schema.mjs';
import { stage, startRegistry } from './quarantine.mjs';

export function consumerArguments(args) {
  const { values } = parseArgs({
    args,
    allowPositionals: false,
    options: {
      manifest: { type: 'string' },
      'manifest-sha256': { type: 'string' },
      output: { type: 'string' },
      root: { type: 'string', multiple: true, default: [] },
      'external-proxy': { type: 'string' },
      help: { type: 'boolean' }
    }
  });
  if (values.help) return values;
  demand(values.manifest && isAbsolute(values.manifest) && values.output && isAbsolute(values.output), 'Manifest/output must be absolute paths');
  demand(/^[a-f0-9]{64}$/.test(values['manifest-sha256'] || ''), 'Expected manifest SHA256 required');
  demand(values['external-proxy'] === undefined || values['external-proxy'] === 'npmjs', 'Only explicit npmjs read proxy supported');
  return values;
}

function newReport(options) {
  return {
    schemaVersion: 1,
    timestamp: new Date().toISOString(),
    beads: ['redemeine-cwxu', 'redemeine-cwxu.2'],
    purpose: 'requested isolated consumer scope only; never full-release-qualified',
    platform: tools.platform,
    toolPins: tools,
    inputSha256: options['manifest-sha256'],
    exitCode: 2,
    complete: false,
    staging: { receipts: [] },
    consumers: [],
    notValidated: ['public publication/provenance/channel', 'Bun and non-linux/amd64 platforms', 'unselected roots', 'arbitrary-code sandboxing']
  };
}

export function signalHandlers(report) {
  const controller = new AbortController();
  const interrupt = (signal) => {
    report.interrupted = signal;
    controller.abort();
  };
  const sigint = () => interrupt('SIGINT');
  const sigterm = () => interrupt('SIGTERM');
  process.once('SIGINT', sigint);
  process.once('SIGTERM', sigterm);
  return {
    signal: controller.signal,
    dispose: () => {
      process.removeListener('SIGINT', sigint);
      process.removeListener('SIGTERM', sigterm);
    }
  };
}

async function finish(options, report, state, signals) {
  signals.dispose();
  if (state) {
    try {
      if (!(await cleanup(state))) report.exitCode = 2;
    } catch {
      report.cleanup = { complete: false };
      report.exitCode = 2;
    }
  }
  if (signals.signal.aborted) report.exitCode = 2;
  if (report.exitCode === 2) report.complete = false;
  report.coverage = (report.requestedConsumers || []).map((requested) => {
    const result = report.consumers.find((entry) => entry.node === requested.node && entry.root.includes(requested.root));
    const status = result?.failureKind === 'coverage-incomplete' ? 'blocked' : result ? 'attempted' : 'not-run';
    return { ...requested, exitCode: result?.exitCode ?? null, status };
  });
  report.finishedAt = new Date().toISOString();
  await writeFile(resolve(options.output, 'result.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
}

async function retainInput(options, report, policyBytes) {
  const policy = policyBytes || (await readFile(new URL('./policy.json', import.meta.url)));
  const input = await loadInput(options.manifest, options['manifest-sha256'], resolve(options.output, 'snapshot'), policy);
  await writeFile(resolve(options.output, 'input-manifest.json'), input.bytes, { mode: 0o600 });
  const { repository, tools, policy: policyObject, inputs, diagnostics, verdict } = input.manifest;
  report.input = { repository, tools, policy: policyObject, inputs, diagnostics, verdict };
  return input;
}

export async function qualify(options, policyBytes = undefined) {
  await mkdir(options.output, { mode: 0o700 });
  await noLinks(options.output);
  const report = newReport(options);
  const signals = signalHandlers(report);
  let state;
  try {
    const input = await retainInput(options, report, policyBytes);
    if (input.verdict !== 0) {
      report.exitCode = input.verdict;
      report.complete = input.verdict === 1;
      report.notValidated.push('all staging and consumers: A did not pass');
    } else {
      state = await withDockerSignal(signals.signal, () => executeQualification(options, report, input));
      report.exitCode = 0;
      report.complete = true;
    }
  } catch (error) {
    report.exitCode = error.code === 1 ? 1 : 2;
    report.error = error.message;
    state ||= error.consumerState;
  } finally {
    await finish(options, report, state, signals);
  }
  return report;
}

async function executeQualification(options, report, input) {
  const selection = selectRoots(input, options.root);
  report.selection = selection;
  report.graph = input.graph;
  report.copies = input.copies;
  report.requestedConsumers = tools.nodes.flatMap((node) => selection.roots.map((root) => ({ root, node: node.version })));
  const plans = planConsumers(input, selection);
  const state = dockerRun(options.output, report);
  report.runId = state.id;
  await writeFile(resolve(options.output, 'run.json'), JSON.stringify({ runId: state.id }), { mode: 0o600 });
  try {
    const images = await provision(state);
    const registry = await startRegistry(state, input, options['external-proxy']);
    await stage(state, input, selection, registry, images[0]);
    await runConsumers(state, input, selection, registry, images, plans);
    return state;
  } catch (error) {
    error.consumerState = state;
    throw error;
  }
}

export async function main(args = process.argv.slice(2)) {
  try {
    const options = consumerArguments(args);
    if (options.help) {
      console.log(
        '--manifest <absolute A manifest> --manifest-sha256 <digest> --output <fresh absolute dir> [--root name@exact] [--external-proxy npmjs]\nLocal disposable writes only. Exit 0 requested scope, 1 artifact failure, 2 incomplete/setup/input. Trusted code; Linux amd64 only.'
      );
      return 0;
    }
    return (await qualify(options)).exitCode;
  } catch (error) {
    console.error(error.message);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await main();
