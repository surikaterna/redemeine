import { budgets, QualificationError } from './plan';
import { isRecord, waitUntil } from './schema';
import type { ExternalStack } from './stack';
type ProducerDiagnosticStack = Pick<ExternalStack, 'docker' | 'receipt' | 'observer' | 'producer' | 'signal'>;

export async function producerFacts(stack: ProducerDiagnosticStack, phase: string): Promise<void> {
  const value = await stack.docker.inspectContainer(stack.producer, stack.signal);
  const state = isRecord(value.State) ? value.State : {};
  const exit = state.ExitCode;
  stack.receipt.provenance.producerScenario = { phase, checkpoint: await stack.observer.checkpointDiagnostic(),
    ...(typeof state.Running === 'boolean' ? { running: state.Running } : {}),
    ...(typeof exit === 'number' && Number.isSafeInteger(exit) && exit >= 0 && exit <= 255 ? { exitCode: exit } : {}) };
  await stack.receipt.save();
}

export async function producerWait(stack: ProducerDiagnosticStack, phase: 'boundary' | 'return_baseline' | 'mandatory_return', check: () => Promise<boolean>): Promise<void> {
  await producerFacts(stack, `waiting_${phase}`);
  try { await waitUntil(check, budgets.scenarioMs, stack.signal); }
  catch (error) {
    try { await producerFacts(stack, `failed_${phase}`); }
    catch {
      stack.receipt.provenance.producerScenario = { phase: `failed_${phase}`, diagnosticUnavailable: true };
      await stack.receipt.save();
    }
    if (error instanceof QualificationError && error.reason === 'qualification_condition_deadline') {
      throw new QualificationError(`producer_${phase}_deadline`);
    }
    throw error;
  }
  await producerFacts(stack, `observed_${phase}`);
}
