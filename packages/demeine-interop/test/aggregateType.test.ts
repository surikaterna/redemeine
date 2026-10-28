import { createDemeineBridge } from '../src';
import { definition } from './fixture';

test.each([undefined, null, '', '   ', 0, {}, false])(
  'rejects invalid explicit aggregateType %p before inspecting lifecycle hooks', aggregateType => {
    const built = definition();
    const hooks = jest.fn(() => { throw new Error('lifecycle inspected'); });
    const candidate = Object.defineProperty({ ...built, aggregateType }, 'hooks', { get: hooks });
    expect(() => Reflect.apply(createDemeineBridge, undefined, [candidate]))
      .toThrow('aggregateType must be a nonempty string');
    expect(hooks).not.toHaveBeenCalled();
  },
);

test('missing aggregateType is not inferred from command wires or an instance type getter', () => {
  const { aggregateType: _aggregateType, ...candidate } = definition();
  const type = jest.fn(() => 'guessed');
  Object.defineProperty(candidate, 'type', { get: type });
  expect(() => Reflect.apply(createDemeineBridge, undefined, [candidate]))
    .toThrow('aggregateType must be a nonempty string');
  expect(type).not.toHaveBeenCalled();
});

test('explicit type wins over wire prefixes, including aggregates without commands', () => {
  const built = definition();
  expect(new (createDemeineBridge({ ...built, aggregateType: 'Explicit' }))().type).toBe('Explicit');
  expect(new (createDemeineBridge({ ...built, aggregateType: 'Empty',
    types: { commands: {}, events: {} }, commandCreators: {} }))().type).toBe('Empty');
});

test('unknown runtime options do not supply a lifecycle implementation', () => {
  const implementation = jest.fn(() => { throw new Error('unexpected lifecycle'); });
  const Bridge = Reflect.apply(createDemeineBridge, undefined, [definition(), { implementation }]);
  expect(new Bridge().type).toBe('counter');
  expect(implementation).not.toHaveBeenCalled();
});
