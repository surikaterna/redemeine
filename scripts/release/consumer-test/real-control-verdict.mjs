const matrixError = 'Consumer matrix did not fully qualify; all runtime/root outcomes retained';
const nodes = ['22.23.3', '24.20.0'];

export function isExpectedCliCoverage(report) {
  if (report?.exitCode !== 2 || report.complete !== false || report.error !== matrixError) return false;
  // Expected consumer blockers cannot excuse an independent run/teardown failure.
  const failureFields = ['interrupted', 'signal', 'failureKind', 'infrastructureFailure', 'errors', 'failures'];
  if (failureFields.some((key) => Object.hasOwn(report, key))) return false;
  if (report.cleanup?.complete !== true || !Array.isArray(report.cleanup.failures) || report.cleanup.failures.length !== 0) return false;
  if (report.staging?.exitCode !== 0 || !Array.isArray(report.consumers) || report.consumers.length !== nodes.length) return false;
  return report.consumers.every((consumer, index) => expectedConsumer(consumer, nodes[index])) && healthyResources(report);
}

function expectedConsumer(consumer, node) {
  const generation = consumer?.cliGeneration;
  return (
    consumer?.node === node &&
    consumer.exitCode === 2 &&
    consumer.failureKind === 'coverage-incomplete' &&
    generation?.status === 'blocked' &&
    generation.reason === 'missing-prerequisites' &&
    Array.isArray(generation.missing) &&
    generation.missing.length === 1 &&
    generation.missing[0] === '@redemeine/aggregate' &&
    ['input', 'extraction', 'generatedTypes', 'schemaBehavior'].every((phase) => generation[phase] === 'not-run') &&
    ['install', 'installedGraph', 'cliApi', 'cliDeclarations'].every((phase) => consumer.phases?.[phase] === 'passed')
  );
}

function healthyResources(report) {
  return (
    Array.isArray(report.resourceOutcomes) &&
    report.resourceOutcomes.length > 0 &&
    completeConsumerResources(report) &&
    report.resourceOutcomes.every(
      (resource) =>
        resource?.oomKilled === false &&
        (resource.exitCode === 0 ||
          (resource.exitCode === 2 &&
            resource.running === false &&
            typeof resource.id === 'string' &&
            report.consumers.some((consumer) => consumer.identity?.id === resource.id)))
    )
  );
}

function completeConsumerResources(report) {
  const ids = report.consumers.map((consumer) => consumer.identity?.id);
  if (ids.some((id) => typeof id !== 'string' || id.length === 0) || new Set(ids).size !== ids.length) return false;
  return ids.every((id) => {
    const outcomes = report.resourceOutcomes.filter((resource) => resource?.id === id);
    return outcomes.length === 1 && outcomes[0].running === false && outcomes[0].oomKilled === false && outcomes[0].exitCode === 2;
  });
}
