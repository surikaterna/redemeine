import type { Event, EventType, EnvelopeHeaders } from './types';
import { createIdentity } from './identity';

/**
 * Type representing a compiled event factory with introspectable `.type` property.
 *
 * @since 0.1.0
 */
export type EventFactory<P = void, T extends EventType | string = EventType> =  
    ((...args: unknown[]) => Event<P, T>) & { type: T, toString: () => T };

/**
 * Creates a typed event factory for producing domain events.
 *
 * The returned factory generates events with unique IDs and the specified type.
 * Attach an optional `preparePayload` function to transform arguments into
 * the event payload shape.
 *
 * @example
 * ```typescript
 * const orderPlaced = createEvent<{ orderId: string }>('order.placed.event');
 * const event = orderPlaced({ orderId: '123' });
 * // => { id: '...', type: 'order.placed.event', payload: { orderId: '123' } }
 * ```
 *
 * @param type - The canonical event type identifier
 * @param preparePayload - Optional transform to build payload from factory arguments
 * @returns An event factory function with a `.type` property for introspection
 * @since 0.1.0
 */
export const createEvent = <P = void, T extends EventType | string = EventType>(
  type: T,
  preparePayload?: (...args: unknown[]) => { payload: P; headers?: EnvelopeHeaders }
): EventFactory<P, T> => {
  function eventFactory(...args: unknown[]) {
    const id = createIdentity();
    if (typeof preparePayload === 'function') {
      const prepared = preparePayload(...args);
      return {
        id,
        type,
        payload: prepared.payload,
        ...(prepared.headers !== undefined ? { headers: prepared.headers } : {})
      };
    }
    return { id, type, payload: args[0] as P };
  }

  eventFactory.toString = () => type;
  eventFactory.type = type;
  
  return eventFactory as EventFactory<P, T>;
};
