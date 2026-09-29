import { runOwnedChild } from './owned-child-run.mjs';

const PHASE = 'jest-process';
const SOURCE = 'owned-child-run';
const LIMIT = 4_096;

function bounded(value) {
  return Number.isSafeInteger(value) && value >= 0 ? Math.min(value, LIMIT + 1) : 0;
}

/** Never allow the credentials-bearing Jest invocation to inherit or return raw output. */
export function runCrashJest(command, args, options) {
  return runOwnedChild(command, args, { ...options, capture: true, withholdOutput: true });
}

/** Copy only numeric process evidence; neither raw child output nor exception text escapes. */
export function crashProcessReport(result) {
  const code = result?.code;
  const exitCode = Number.isSafeInteger(code) && code >= 0 && code <= 255 ? code : null;
  const errorClass = !result ? 'reap_failure' : result.timedOut ? 'timeout' :
    result.signal ? 'signal' : exitCode === 0 ? 'none' : 'nonzero_exit';
  return { phase: PHASE, source: SOURCE, errorClass, exitCode,
    stdoutBytes: bounded(result?.output?.stdoutBytes), stderrBytes: bounded(result?.output?.stderrBytes),
    stdoutTruncated: result?.output?.stdoutTruncated === true,
    stderrTruncated: result?.output?.stderrTruncated === true };
}

export function crashScenarioReport(report) {
  if (!Array.isArray(report?.testResults)) return [];
  return report.testResults.slice(0, 2).flatMap(suite => Array.isArray(suite.assertionResults) ?
    suite.assertionResults.slice(0, 4).map(assertion => ({ name: 'retry crash process-kill scenario',
      status: ['passed', 'failed', 'pending'].includes(assertion.status) ? assertion.status : 'failed',
      durationMs: Number.isSafeInteger(assertion.duration) && assertion.duration >= 0 ? assertion.duration : null,
      failures: Array.isArray(assertion.failureMessages) ?
        assertion.failureMessages.slice(0, 8).map(() => 'sanitized crash scenario failure') : [] })) : []);
}

export function crashProofComplete(evidence) {
  const cleanup = evidence?.cleanup;
  const resources = cleanup?.resources;
  return evidence?.success === true && evidence?.firstFailure === null && evidence?.cleanupFailure === null &&
    evidence?.exitSignal === 'SIGKILL' && cleanup?.ownedChildrenReaped === true &&
    cleanup?.amqpClosed === true && cleanup?.mongoClosed === true &&
    resources && ['vhost', 'user', 'db'].every(key => ['removed', 'absent'].includes(resources[key]?.status));
}
