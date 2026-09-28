import type { SagaTurnAppendRequest, SagaTurnAppendResult, SagaTurnRepository } from '@redemeine/saga-runtime';
import { wrapRepository } from './harness';

export function concurrentIntents(base: SagaTurnRepository) {
  let armed = false;
  let arrivals = 0;
  let release: () => void = () => undefined;
  const together = new Promise<void>(resolve => { release = resolve; });
  const requests: SagaTurnAppendRequest[] = [];
  const statuses: SagaTurnAppendResult['status'][] = [];
  const outcomes: Array<{ request: SagaTurnAppendRequest; status: SagaTurnAppendResult['status'] }> = [];
  return { requests, statuses, outcomes, arm: () => { armed = true; },
    repository: wrapRepository(base, async request => {
      requests.push(request);
      if (armed && arrivals < 2) {
        arrivals += 1;
        if (arrivals === 2) release();
        await together;
      }
      const outcome = await base.append(request);
      statuses.push(outcome.status);
      outcomes.push({ request, status: outcome.status });
      return outcome;
    }) };
}

export function gatedFanout(base: SagaTurnRepository, lateSagaKey: string) {
  let failOnce = true;
  let armed = false;
  let entered: () => void = () => undefined;
  let release: () => void = () => undefined;
  const arrival = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const requests: SagaTurnAppendRequest[] = [];
  return { arrival, release, requests, arm: () => { armed = true; }, repository: wrapRepository(base, async request => {
    requests.push(request);
    if (armed && request.identity.sagaKey === lateSagaKey && failOnce) {
      entered();
      await gate;
      failOnce = false;
      throw new Error('injected late fanout failure before append');
    }
    return base.append(request);
  }) };
}
