import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createEvent } from '../src/createEvent';
import { createCommand } from '../src/createCommand';
import { setIdentityFactory, resetIdentityFactory } from '../src/identity';

describe('createEvent', () => {
  beforeEach(() => {
    let counter = 0;
    setIdentityFactory(() => `evt-${++counter}`);
  });
  afterEach(() => resetIdentityFactory());

  it('creates an event with type and payload', () => {
    const userCreated = createEvent<{ name: string }>('user.created');
    const event = userCreated({ name: 'Alice' });
    expect(event.type).toBe('user.created');
    expect(event.payload).toEqual({ name: 'Alice' });
    expect(event.id).toBe('evt-1');
  });

  it('factory exposes .type property', () => {
    const factory = createEvent('order.placed');
    expect(factory.type).toBe('order.placed');
  });

  it('factory toString returns type', () => {
    const factory = createEvent('item.added');
    expect(factory.toString()).toBe('item.added');
    expect(`${factory}`).toBe('item.added');
  });

  it('supports preparePayload callback', () => {
    const factory = createEvent<{ total: number }>('calc.done', (a: unknown, b: unknown) => ({
      payload: { total: (a as number) + (b as number) },
      headers: { source: 'test' },
    }));
    const event = factory(2, 3);
    expect(event.payload).toEqual({ total: 5 });
    expect((event as any).headers).toEqual({ source: 'test' });
  });

  it('generates unique ids per call', () => {
    const factory = createEvent('x');
    const e1 = factory();
    const e2 = factory();
    expect(e1.id).not.toBe(e2.id);
  });
});

describe('createCommand', () => {
  beforeEach(() => {
    let counter = 0;
    setIdentityFactory(() => `cmd-${++counter}`);
  });
  afterEach(() => resetIdentityFactory());

  it('creates a command with type and payload', () => {
    const doThing = createCommand<{ value: number }>('do.thing');
    const cmd = doThing({ value: 42 });
    expect(cmd.type).toBe('do.thing');
    expect(cmd.payload).toEqual({ value: 42 });
    expect(cmd.id).toBe('cmd-1');
  });

  it('factory exposes .type and toString', () => {
    const factory = createCommand('test.cmd');
    expect(factory.type).toBe('test.cmd');
    expect(factory.toString()).toBe('test.cmd');
  });

  it('supports prepareCommand callback', () => {
    const factory = createCommand('prepared', (name: string) => ({
      payload: { name: name.toUpperCase() },
      headers: { priority: 'high' },
    }));
    const cmd = factory('alice');
    expect(cmd.payload).toEqual({ name: 'ALICE' });
    expect((cmd as any).headers).toEqual({ priority: 'high' });
  });

  it('throws if prepareCommand returns falsy', () => {
    const factory = createCommand('bad', () => undefined as any);
    expect(() => factory()).toThrow('prepareCommand did not return');
  });
});
