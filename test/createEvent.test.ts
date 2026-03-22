import { describe, expect, test } from '@jest/globals';
import { createEvent } from '../src/createEvent';

describe('createEvent', () => {
    test('should create an event factory without a prepare function', () => {
        const eventFactory = createEvent<string>('order.cancelled.event');
        const event = eventFactory('user requested');
        
        expect(event).toEqual({ type: 'order.cancelled.event', payload: 'user requested' });
        expect(eventFactory.type).toBe('order.cancelled.event');
        expect(eventFactory.toString()).toBe('order.cancelled.event');
    });

    test('should create an event factory with a prepare function taking multiple args', () => {
        const eventFactory = createEvent('order.updated.event', (id: string, details: any) => ({
            payload: { id, details }
        }));
        
        const event = eventFactory('o1', { status: 'closed' });
        expect(event).toEqual({ 
            type: 'order.updated.event', 
            payload: { id: 'o1', details: { status: 'closed' } } 
        });
    });

    test('should allow empty payload creation', () => {
        const emptyEventFactory = createEvent<void>('heartbeat.event');
        const event = emptyEventFactory();
        expect(event).toEqual({ type: 'heartbeat.event', payload: undefined });
    });
});
