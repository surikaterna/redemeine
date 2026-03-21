import { Event, EventType } from "./types";

export const createEvent = <E, T extends EventType = EventType>(
  type: T,
  preparePayload?: (payload: E) => Record<string, any>
): ((argument?: E) => Event<Record<string, any>>) => {
  return (payload?: E) => {
    const cmd = { type };
    const p = typeof preparePayload == 'function' ? preparePayload(payload) : { payload };
    return { type, payload: p.payload };
  };
};
