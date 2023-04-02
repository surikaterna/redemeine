interface Command<S = any, P extends any = any> {
  type: string;
  payload: P;
}

export type Commands<T extends keyof any = string, P extends any = any> = Record<T, Command<P>>;

export const createCommand = <T>(type: string, preparePayload?: (T) => Record<string, any>): ((argument: T) => Command<Record<string, any>>) => {
  return (payload?: T) => {
    const cmd = { type };
    const p = typeof preparePayload == 'function' ? preparePayload(payload) : { payload };
    return { type, payload: p.payload };
  };
};
