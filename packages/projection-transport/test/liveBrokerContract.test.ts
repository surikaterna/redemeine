import type { LiveBrokerStartRecord } from '@redemeine/projection-runtime-core';
import { validateLiveStart } from '../src/liveRegistration';
import { liveStart } from './orderedLiveFeedFixture';

const broker: LiveBrokerStartRecord = { mode: 'LIVE_FROM_QUEUE_BINDING', epoch: 'epoch', queueName: 'rdm.projection.commits',
  vhost: '/', bindingRef: 'binding', registryDigest: 'registry', generation: 'generation', sourceScopeDigest: 'scope',
  provisioningRef: 'control', queueNonce: 'nonce', publisherContract: { ordering: 'external_single_ordered_publisher',
    recoveryPolicy: 'external_best_effort_on_expiry', historicalCompleteness: 'unknown' } };

test('native and broker start variants remain distinct, broker does not require a fabricated native start', () => {
  expect(() => validateLiveStart(liveStart)).not.toThrow();
  expect(() => validateLiveStart(broker)).not.toThrow();
  expect('nativeStartRef' in broker).toBe(false);
});

test.each(['nativeStartRef', 'publisherRef', 'orderedFeedQualificationRef'])('broker cannot masquerade as native proof with %s', (field) => {
  expect(() => validateLiveStart({ ...broker, [field]: 'fake' })).toThrow('unsupported_publisher_contract');
});

test('broker descriptor cannot carry a trusted Boolean or empty binding identity', () => {
  const candidate = { ...broker, publisherContract: { ...broker.publisherContract, trusted: true } };
  expect(() => validateLiveStart(candidate)).toThrow('unsupported_publisher_contract');
  expect(() => validateLiveStart({ ...broker, queueNonce: '' })).toThrow('unproven_live_start');
});
