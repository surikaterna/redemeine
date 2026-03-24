import { afterEach, describe, expect, test } from '@jest/globals';
import { createEvent } from '../src/createEvent';
import { resetIdentityFactory, setIdentityFactory } from '../src/identity';

describe('createEvent', () => {
    afterEach(() => {
        resetIdentityFactory();
    });

    test('should create event with generated id by default', () => {
        const eventFactory = createEvent<string>('order.cancelled.event');
        const event = eventFactory('user requested');

        expect(event.id).toEqual(expect.any(String));
        expect(event.type).toBe('order.cancelled.event');
        expect(event.payload).toBe('user requested');
    });

    test('should create an event factory without a prepare function', () => {
        const eventFactory = createEvent<string>('order.cancelled.event');
        const event = eventFactory('user requested');
        
        expect(event).toEqual({ id: expect.any(String), type: 'order.cancelled.event', payload: 'user requested' });
        expect(eventFactory.type).toBe('order.cancelled.event');
        expect(eventFactory.toString()).toBe('order.cancelled.event');
    });

    test('should create an event factory with a prepare function taking multiple args', () => {
        const eventFactory = createEvent('order.updated.event', (id: string, details: any) => ({
            payload: { id, details }
        }));
        
        const event = eventFactory('o1', { status: 'closed' });
        expect(event).toEqual({
            id: expect.any(String),
            type: 'order.updated.event', 
            payload: { id: 'o1', details: { status: 'closed' } } 
        });
    });

    test('should use custom IdentityFactory when provided', () => {
        setIdentityFactory(() => 'event-fixed-id');
        const eventFactory = createEvent<string>('order.cancelled.event');
        const event = eventFactory('x');

        expect(event.id).toBe('event-fixed-id');
    });

    test('should allow empty payload creation', () => {
        const emptyEventFactory = createEvent<void>('heartbeat.event');
        const event = emptyEventFactory();
        expect(event).toEqual({ id: expect.any(String), type: 'heartbeat.event', payload: undefined });
    });
});
