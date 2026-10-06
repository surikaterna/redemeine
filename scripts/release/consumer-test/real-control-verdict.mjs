import { isDeepStrictEqual as equal } from 'node:util';
import { artifactKey } from '../consumer-graph.mjs';

const matrixError = 'Consumer matrix did not fully qualify; all runtime/root outcomes retained';
const coverageError = 'CLI generated-project coverage is incomplete: missing documented prerequisite';

export function isExpectedRepositoryRejection(report, context) {
  if (!boundInput(report, context, 1) || report.exitCode !== 1 || report.complete !== true) return false;
  const absent = ['error', 'interrupted', 'images', 'registry', 'resourceOutcomes', 'runId', 'selection', 'requestedConsumers', 'cleanup', 'imageCleanup'];
  return (
    absent.every((key) => !Object.hasOwn(report, key)) && equal(report.staging, { receipts: [] }) && equal(report.consumers, []) && equal(report.coverage, [])
  );
}

export function isExpectedCliCoverage(report, context) {
  if (!boundInput(report, context, 0) || !equal(context.roots, ['@redemeine/cli@0.1.0'])) return false;
  if (report.exitCode !== 2 || report.complete !== false || report.error !== matrixError || Object.hasOwn(report, 'interrupted')) return false;
  if (report.cleanup?.complete !== true || !equal(report.cleanup.failures, [])) return false;
  if (!expectedSelection(report, context) || !expectedStaging(report.staging, context)) return false;
  return expectedMatrix(report, context) && healthyResources(report);
}

function boundInput(report, context, code) {
  const input = context?.input;
  const manifest = input?.manifest;
  if (!report || context?.a !== code || input?.verdict !== code || manifest?.exitCode !== code || manifest.complete !== true) return false;
  if (typeof input.digest !== 'string' || report.inputSha256 !== input.digest || !Array.isArray(manifest.diagnostics)) return false;
  if (manifest.verdict !== (code === 0 ? 'static-clean' : 'violations')) return false;
  if (code === 0 ? manifest.diagnostics.length !== 0 : !manifest.diagnostics.length || manifest.diagnostics.some((d) => d.severity !== 'error')) return false;
  return ['repository', 'tools', 'policy', 'inputs', 'diagnostics', 'verdict'].every(
    (key) => manifest[key] !== undefined && equal(report.input?.[key], manifest[key])
  );
}

function expectedSelection(report, { roots, selection, input }) {
  return (
    equal(selection?.roots, roots) &&
    Array.isArray(selection.order) &&
    selection.order.length > 0 &&
    ['roots', 'unselected', 'order'].every((key) => equal(report.selection?.[key], selection[key])) &&
    Array.isArray(input.artifacts) &&
    selection.order.every((key) => input.artifacts.filter((a) => artifactKey(a) === key).length === 1)
  );
}

function expectedStaging(staging, { selection, input }) {
  if (staging?.exitCode !== 0 || Object.hasOwn(staging, 'error') || !Array.isArray(staging.receipts)) return false;
  if (staging.receipts.length !== selection.order.length) return false;
  return selection.order.every((key, index) => {
    const artifact = input.artifacts.find((a) => artifactKey(a) === key);
    const expected = {
      key,
      file: `${index}.tgz`,
      name: artifact.manifest.name,
      version: artifact.manifest.version,
      sha256: artifact.sha256,
      integrity: artifact.integrity,
      origins: artifact.origins,
      downloadedSha256: artifact.sha256,
      downloadedIntegrity: artifact.integrity
    };
    const receipt = staging.receipts[index];
    return Object.entries(expected).every(([field, value]) => equal(receipt?.[field], value)) && receipt?.dist?.integrity === artifact.integrity;
  });
}

function expectedMatrix(report, { roots, pins }) {
  if (!Array.isArray(pins?.nodes) || pins.nodes.length !== 2 || !expectedTools(report, pins)) return false;
  const pairs = pins.nodes.flatMap((node) => roots.map((root) => ({ root, node: node.version })));
  if (!matchesPairs(report.requestedConsumers, pairs) || !matchesPairs(report.coverage, pairs)) return false;
  if (!report.coverage.every((c) => c.exitCode === 2 && c.status === 'blocked')) return false;
  if (!Array.isArray(report.consumers) || report.consumers.length !== pairs.length) return false;
  return report.consumers.every((consumer, index) => expectedConsumer(consumer, pairs[index], pins));
}

function expectedTools(report, pins) {
  if (!['platform', 'nodes', 'registry', 'npm', 'typescript', 'nodeTypes'].every((key) => equal(report.toolPins?.[key], pins[key]))) return false;
  if (report.platform !== pins.platform || report.registry?.version !== pins.registry.version) return false;
  if (!Array.isArray(report.images) || report.images.length !== pins.nodes.length) return false;
  return pins.nodes.every((node, index) => {
    const image = report.images[index];
    return (
      image?.version === node.version &&
      image.image === node.image &&
      image.actual?.node === node.version &&
      image.actual?.npm === pins.npm.version &&
      image.actual?.typescript === pins.typescript
    );
  });
}

function matchesPairs(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    expected.every((pair, index) => actual[index]?.root === pair.root && actual[index]?.node === pair.node)
  );
}

function expectedConsumer(consumer, pair, pins) {
  const generation = consumer?.cliGeneration;
  return (
    consumer?.node === pair.node &&
    equal(consumer.root, [pair.root]) &&
    consumer.npm === pins.npm.version &&
    consumer.exitCode === 2 &&
    consumer.failureKind === 'coverage-incomplete' &&
    consumer.error === coverageError &&
    generation?.status === 'blocked' &&
    generation.reason === 'missing-prerequisites' &&
    equal(generation.missing, ['@redemeine/aggregate']) &&
    ['input', 'extraction', 'generatedTypes', 'schemaBehavior'].every((phase) => generation[phase] === 'not-run') &&
    ['install', 'installedGraph', 'cliApi', 'cliDeclarations'].every((phase) => consumer.phases?.[phase] === 'passed')
  );
}

function healthyResources(report) {
  const identities = [report.registry?.identity, report.staging?.identity, ...report.consumers.map((c) => c.identity)];
  if (typeof report.runId !== 'string' || !report.runId.length || !identities.every((identity) => validIdentity(identity, report.runId))) return false;
  const ids = identities.map((identity) => identity.id);
  if (new Set(ids).size !== ids.length || report.registry.id !== ids[0]) return false;
  if (!Array.isArray(report.resourceOutcomes) || report.resourceOutcomes.length !== ids.length) return false;
  // Outcomes are observations BEFORE removal: the registry is still running, all jobs have stopped.
  return ids.every((id, index) => {
    const outcomes = report.resourceOutcomes.filter((resource) => resource?.id === id);
    return outcomes.length === 1 && outcomes[0].running === (index === 0) && outcomes[0].oomKilled === false && outcomes[0].exitCode === (index < 2 ? 0 : 2);
  });
}

function validIdentity(identity, runId) {
  return typeof identity?.id === 'string' && identity.id.length > 0 && identity.labels?.['org.redemeine.consumer-run'] === runId;
}
