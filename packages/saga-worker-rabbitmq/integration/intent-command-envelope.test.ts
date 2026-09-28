import { expect, it } from '@jest/globals';
import { payCommandEnvelopes } from './intentFixtures';

it('uses aggregate creator envelopes, not handler-return objects, for canonical dispatch', () => {
  const [defaultName, overrideName] = payCommandEnvelopes();
  if (!defaultName || !overrideName) throw new Error('missing aggregate command creator');
  for (const command of [defaultName, overrideName]) {
    expect(Object.keys(command).sort()).toEqual(['id', 'payload', 'type']);
    expect(command).toMatchObject({ id: expect.stringMatching(/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/) });
    expect(command.payload).toBe('a1');
  }
  expect(defaultName.type).toBe('invoice.pay.command');
  expect(overrideName.type).toBe('billing.charge.command');
});
