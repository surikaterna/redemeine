interface Event<P> {
  type: string;
  payload: P;
}
export const createEvent = <T>(type: string, preparePayload?: (T) => Record<string, any>): ((argument: T) => Event<Record<string, any>>) => {
  return (payload?: T) => {
    const cmd = { type };
    const p = typeof preparePayload == 'function' ? preparePayload(payload) : { payload };
    return { type, payload: p.payload };
  };
};
