type EventType = `${string}.event`;

export interface Event<P = any, T extends EventType = EventType> {
  type: T;
  payload: P;
}
export const createEvent = <E, T extends EventType = EventType>(
  type: T,
  preparePayload?: (E) => Record<string, any>
): ((argument: E) => Event<Record<string, any>>) => {
  return (payload?: E) => {
    const cmd = { type };
    const p = typeof preparePayload == 'function' ? preparePayload(payload) : { payload };
    return { type, payload: p.payload };
  };
};
