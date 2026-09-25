import { createHash } from 'node:crypto';

const original = 'saga-real-stack.integration.test.ts';
const intent = 'saga-intent-real.integration.test.ts';
const identity = 'saga-identity-real.integration.test.ts';
const identitySlices = ['redemeine-371j.1', 'redemeine-371j.2'];

export function selectRealStackSuites(slice) {
  if (identitySlices.includes(slice)) return { issue: slice, paths: [identity] };
  if (slice !== undefined && slice !== 'redemeine-vpwm.3.3') throw new Error('Unsupported real-stack slice');
  return { issue: 'redemeine-vpwm.3.3', paths: [original, intent] };
}

export async function scenarioHash(paths, readSource) {
  const hash = createHash('sha256');
  for (const name of paths) {
    const bytes = await readSource(name);
    hash.update(name).update('\0').update(String(bytes.length)).update('\0').update(bytes);
  }
  return hash.digest('hex');
}

export function assertScenarioEvidence(report, paths) {
  if (report?.success === false || !Array.isArray(report?.testResults) || report.testResults.length !== paths.length) {
    throw new Error('Missing or unexpected real-stack test suites');
  }
  for (const name of paths) {
    const suites = report.testResults.filter(result => result.name?.endsWith(`/integration/${name}`));
    if (suites.length !== 1 || !Array.isArray(suites[0].assertionResults) ||
        suites[0].assertionResults.length === 0 ||
        suites[0].assertionResults.some(result => result.status !== 'passed')) {
      throw new Error(`Missing, empty or unsuccessful real-stack suite: ${name}`);
    }
  }
}
