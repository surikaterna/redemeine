import { Event, EventType } from "./types";

export type EventFactory<P = void, T extends EventType | string = EventType> = 
    ((...args: any[]) => Event<P, T>) & { type: T, toString: () => T };

export const createEvent = <P = void, T extends EventType | string = EventType>(
  type: T,
  preparePayload?: (...args: any[]) => { payload: P }
): EventFactory<P, T> => {
  function eventFactory(...args: any[]) {
    if (typeof preparePayload === 'function') {
      const prepared = preparePayload(...args);
      return { type, payload: prepared.payload };
    }
    return { type, payload: args[0] as P };
  }

  eventFactory.toString = () => type;
  eventFactory.type = type;
  
  return eventFactory as EventFactory<P, T>;
};
