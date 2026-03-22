import { Command, Event } from './types';
import { Depot } from './Depot';

export interface BuiltAggregate<S, M> {
    initialState: S;
    process: (state: S, command: Command<any, string>) => Event[];
    apply: (state: S, event: Event) => S;
    commandCreators: {
        [K in keyof M]: [M[K]] extends [void] | [undefined] | [never]
            ? () => Command<void, string>
            : (payload: M[K]) => Command<M[K], string>;
    };
}

export type LiveCommandMap<S, M> = {
    [K in keyof M]: [M[K]] extends [void] | [undefined] | [never]
        ? () => Promise<S>
        : (payload: M[K]) => Promise<S>;
};

export const LiveAggregateCoreSymbol = Symbol('LiveAggregateCore');

export class LiveAggregateCore<S> {
    public uncommitted: Event[] = [];
    public version: number = 0;

    constructor(
        public builder: BuiltAggregate<S, any>,
        public id: string,
        public state: S
    ) {}
}

export function createLiveAggregate<S extends {}, Name extends string, M extends Record<string, any>>(
    builder: BuiltAggregate<S, M>,
    id: string,
    initialState?: S
): LiveCommandMap<S, M> & Readonly<S> & Record<string, any> {

    const core = new LiveAggregateCore(builder, id, initialState || builder.initialState);

const makeDeepProxy = (stateTarget: any, path: string[], ids: Record<string, string | number>): any => {
        return new Proxy(typeof stateTarget === 'object' && stateTarget !== null ? stateTarget : () => {}, {
            get(target, prop) {
                if (path.length === 0 && prop === LiveAggregateCoreSymbol) {
                    return core;
                }

                if (typeof prop !== 'string') {
                    return Reflect.get(target, prop);
                }

                if (prop === 'then') return undefined;

                if (["asymmetricMatch", "nodeType", "@@toStringTag", "toJSON", "toString", "valueOf", "inspect"].includes(prop)) {
                    return Reflect.get(target, prop);
                }

                // At root level, always use current core.state to prevent staleness
                const currentTarget = path.length === 0 ? core.state : target;

                // If the property exists in the state object, we proxy it to allow BOTH reading and path-building.
                if (currentTarget && typeof currentTarget === 'object' && prop in currentTarget) {
                    const val = (currentTarget as any)[prop];
                    if (typeof val === 'function' && Array.isArray(currentTarget)) {
                        return val.bind(currentTarget);
                    }
                    if (typeof val === 'object' && val !== null) {
                        return makeDeepProxy(val, [...path, prop], { ...ids });
                    }
                    return val;
                }

                const nextIds = { ...ids };
                const nextPath = [...path];

                if (path.length > 0 && typeof prop === 'string' && !isNaN(Number(prop))) {
                    const parent = path[path.length - 1];
                    nextIds[parent + 'Id'] = prop;
                    nextIds['id'] = prop;
                } else if (path.length > 0 && typeof prop === 'string') {
                    // For string-based IDs like 'abc'
                    if (prop !== 'update' && prop !== 'add' && prop !== 'remove' && prop !== 'delete') {
                         const parent = path[path.length - 1];
                         nextIds[parent + 'Id'] = prop;
                         nextIds['id'] = prop;
                    } else {
                         nextPath.push(prop);
                    }
                } else {
                    nextPath.push(prop);
                }

                return makeDeepProxy(() => {}, nextPath, nextIds);
            },

            apply(target, thisArg, args) {
                const funcName = path.reduce(
                    (acc, p, i) => acc + (i === 0 ? p : p.charAt(0).toUpperCase() + p.slice(1)),
                    ''
                );

                let payload = args[0];

                if (typeof payload === 'object' && payload !== null) {
                    payload = { ...payload, ...ids };
                } else if (payload !== undefined) {
                    if (Object.keys(ids).length > 0) {
                        payload = { value: payload, ...ids };
                    }
                } else if (Object.keys(ids).length > 0) {
                    payload = { ...ids };
                }

                const cmd = (builder.commandCreators as any)[funcName](payload);
                if (!cmd) {
                    throw new Error('Command ' + funcName + ' not found on commandCreators.');
                }
                const events = builder.process(core.state, cmd);
                for (const ev of events) {
                    core.state = builder.apply(core.state, ev);
                    core.uncommitted.push(ev);
                }
                return Promise.resolve(core.state);
            }
        });
    };

    return makeDeepProxy(core.state, [], {}) as LiveCommandMap<S, M> & Readonly<S> & Record<string, any>;
}

export function createLegacyAggregateBridge<S, M>(liveAggregate: LiveCommandMap<S, M> & Readonly<S> & Record<string, any>) {
    const core = (liveAggregate as any)[LiveAggregateCoreSymbol] as LiveAggregateCore<S>;
    if (!core) {
        throw new Error('Target is not a valid LiveAggregate.');
    }
    return {
        get id() { return core.id; },
        get _state() { return core.state; },
        getVersion: () => core.version,
        clearUncommittedEvents: () => { core.uncommitted = []; },
        getUncommittedEvents: () => [...core.uncommitted],
        getUncommittedEventsAsync: async () => [...core.uncommitted],
    };
}

export class LiveAggregateDepot<S, M extends Record<string, any>> {
    constructor(
        private builder: BuiltAggregate<S, M>,
        private depot: Depot<string, S>
    ) {}

    async findById(id: string): Promise<LiveCommandMap<S, M> & Readonly<S> & Record<string, any>> {
        const state = await this.depot.findOne(id);
        return createLiveAggregate(this.builder, id, state || this.builder.initialState);
    }

    new(id: string = Math.random().toString(36).substring(2)): LiveCommandMap<S, M> & Readonly<S> & Record<string, any> {
        return createLiveAggregate(this.builder, id, this.builder.initialState);
    }

    async save(liveAggregate: LiveCommandMap<S, M> & Readonly<S> & Record<string, any>): Promise<S> {
        const core = (liveAggregate as any)[LiveAggregateCoreSymbol] as LiveAggregateCore<S>;
        if (!core) throw new Error('Not a valid LiveAggregate');
        
        await this.depot.save(core.state);
        core.uncommitted = [];
        return core.state;
    }
}
