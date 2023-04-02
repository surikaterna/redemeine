interface Command<P> {
    type: string,
    payload: P
}
export const createCommand = <T>(type: string, preparePayload?: ((T) => Record<string, any>)): ((argument: T) => Command<Record<string, any>>) => {
    return (payload?: T) => {
        const cmd = { type };
        const p = typeof preparePayload == 'function' ? preparePayload(payload) : { payload };
        return { type, payload: p.payload };
    };
};