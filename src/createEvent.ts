import { Event, EventType, EnvelopeHeaders } from './types';
import { createIdentity } from './identity';

/**
 * Foundational type representing a compiled factory that hydrates and constructs explicit domain events.
 */
export type EventFactory<P = void, T extends EventType | string = EventType> =  
    ((...args: any[]) => Event<P, T>) & { type: T, toString: () => T };

/**
 * The foundational building block function allocating explicit events, enforcing internal Redemeine routing protocols natively.
 */
export const createEvent = <P = void, T extends EventType | string = EventType>(
  type: T,
  preparePayload?: (...args: any[]) => { payload: P; headers?: EnvelopeHeaders }
): EventFactory<P, T> => {
  function eventFactory(...args: any[]) {
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
