import { issueId, QualificationError, requireApproval } from './plan';
import { harnessDigest } from './provenance';
import { workspaceRoot } from './workspace';
import { runQualified } from './runner';
import { finalProcessGuard } from './cancellation';

async function main(): Promise<number> {
  if (process.env.HPQ1_ALLOW_DOCKER !== 'external-broker-live-v1-reviewed') throw new QualificationError('qualification_execution_not_approved');
  const root = await workspaceRoot(); const digest = await harnessDigest(root);
  const runId = requireApproval(process.env, digest);
  return runQualified(root, runId, digest);
}

function completed(code: number): void {
  process.exitCode = code;
  finalProcessGuard(code, (exit) => process.exit(exit), () => {
    console.log(JSON.stringify({ issue: issueId, reason: 'qualification_residual_handles_force_exit', outcome: 'fail' }));
  });
}

void main().then(completed).catch((error: unknown) => {
  console.log(JSON.stringify({ issue: issueId, reason: error instanceof QualificationError ? error.reason : 'qualification_preflight_refused' }));
  completed(78);
});
