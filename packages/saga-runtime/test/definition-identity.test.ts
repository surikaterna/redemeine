import { sagaPolicyFingerprint } from '../src/routing/executableIdentity';

const action = (interaction: 'request_response' | 'fire_and_forget') => ({ interaction, build: () => ({}) });
const manifests = [
  { plugin_key: 'beta', version: '2', actions: { send: action('fire_and_forget'), ask: action('request_response') } },
  { plugin_key: 'alpha', actions: { fetch: action('request_response') } }
] as const;
const bindings = { ok: { phase: 'response' }, failed: { phase: 'error' }, retry: { phase: 'retry' } } as const;
const commands = ['order.send', 'order.cancel'];
const schemas = [{ id: 'request', version: 1 }, { id: 'result', version: 2 }];
const fingerprint = () => sagaPolicyFingerprint(manifests, bindings, commands, schemas);

it('uses a frozen v1 vector and sorts only unordered policy components', () => {
  expect(fingerprint()).toBe('662e48e172434e5762280055f0839dd8d54dacc53bc775b704ff06abfdca9870');
  expect(sagaPolicyFingerprint([...manifests].reverse(), { retry: bindings.retry, failed: bindings.failed, ok: bindings.ok },
    [...commands].reverse(), [...schemas].reverse())).toBe(fingerprint());
  expect(sagaPolicyFingerprint([{ ...manifests[0], actions: { ask: manifests[0].actions.ask, send: manifests[0].actions.send } }, manifests[1]], bindings, commands, schemas)).toBe(fingerprint());
  expect(sagaPolicyFingerprint([], {}, [])).toBe('91e619e5861f13fa7f105384cd7fde3a6fcb06ecf5be86f88311632f91133412');
});

it('changes identity for every declarative dimension without hashing callbacks', () => {
  const variants = [
    sagaPolicyFingerprint([{ ...manifests[0], plugin_key: 'changed' }, manifests[1]], bindings, commands, schemas),
    sagaPolicyFingerprint([{ ...manifests[0], version: '3' }, manifests[1]], bindings, commands, schemas),
    sagaPolicyFingerprint([{ ...manifests[0], actions: { send: manifests[0].actions.send, renamed: manifests[0].actions.ask } }, manifests[1]], bindings, commands, schemas),
    sagaPolicyFingerprint([{ ...manifests[0], actions: { send: action('request_response'), ask: manifests[0].actions.ask } }, manifests[1]], bindings, commands, schemas),
    sagaPolicyFingerprint(manifests, { ...bindings, ok: { phase: 'error' } }, commands, schemas),
    sagaPolicyFingerprint(manifests, bindings, ['order.send'], schemas),
    sagaPolicyFingerprint(manifests, bindings, commands, [{ id: 'request', version: 2 }, schemas[1]]),
    sagaPolicyFingerprint(manifests, bindings, commands, [{ id: 'other', version: 1 }, schemas[1]])
  ];
  for (const variant of variants) expect(variant).not.toBe(fingerprint());
  expect(sagaPolicyFingerprint([{ ...manifests[0], actions: { send: action('fire_and_forget'), ask: action('request_response') } }, manifests[1]], bindings, commands, schemas)).toBe(fingerprint());
});

it('refuses malformed, duplicate and unbounded policy data', () => {
  expect(() => sagaPolicyFingerprint([manifests[0], manifests[0]], bindings, commands)).toThrow();
  expect(() => sagaPolicyFingerprint(manifests, bindings, ['order.send', 'order.send'])).toThrow();
  expect(() => sagaPolicyFingerprint(manifests, bindings, commands, [{ id: 'request', version: 1 }, { id: 'request', version: 2 }])).toThrow();
  for (const version of [0, -1, 1.5, Number.NaN]) {
    expect(() => sagaPolicyFingerprint(manifests, bindings, commands, [{ id: 'request', version }])).toThrow();
  }
  expect(() => sagaPolicyFingerprint(manifests, bindings, commands, [{ id: '', version: 1 }])).toThrow();
  expect(() => sagaPolicyFingerprint(manifests, bindings, ['x'.repeat(257)])).toThrow();
});
