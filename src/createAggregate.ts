import { Commands } from './createCommand';
import { Merge } from './utils/Merge';
import { type NestedPairsOf } from './utils/NestedPairOf';

// Flow of things
// func -> command -> (process) -> event -> project(apply) -> state

type ProjectorFunction<S = any, E = any> = (state: S, event: E) => void;

type CommandProcessFunction<S = any, C = any, R = any> = (state: S, command: C) => R;

export type CommandProcessors<State, PF extends Commands> = {
    [K in keyof PF]: CommandProcessFunction<State, PF[K]>;
};

// type CommandFunction<AA extends AggregateProjectors<S>, S = any, E = any> = (state: S, event: E, aggregate: Aggregate<S, AA>) => Event | Event[];

// export type AggregateCommands<State, AA extends AggregateProjectors<State>> = {
//   [K: string]: CommandFunction<AA, State, any>;
// };

// Commands

interface Command2<S = any, P extends any = any> {
    type: string;
    payload: P;
}

type Commands2<T extends keyof any = string, P extends any = any> = Record<T, () => Command2<any, P>>;


// Events

type EventWithCommand<S, P> = {
    [K: string]: (state: S, ...any: never[]) => void;
};

type EventOrEventCommand<S, P extends any = any> = EventWithCommand<S, P> | (() => void);

type Events2<S, T extends keyof any = string, P extends any = any> = Record<T, EventOrEventCommand<S, P>>;
export type AggregateDeclaration<S, C extends Record<string, (...args: any) => any>, E extends Events2<S, any> = Events2<S, any>> = {
    // [K in keyof C]: (a: string) => ReturnType<C[K]>;
} & Merge<Exclude<NestedPairsOf<E, Function>, { project: Function }>>;

export type AggregateSpecification<S, C extends Commands2<any> = Commands2<any>, E extends Events2<S, any> = Events2<S, any>, Name extends string = string> = {
    type: Name;
    initialState: S;
    commands?: C;
    events: E;
};

type WrappedApplyFunction<A = any> = (action: A) => void;



const wrapApplyer = <S, A>(applyer: ProjectorFunction<S, A>) => {
    return (a: A) => {
        applyer(null as S, a);
    };
};

export function createAggregate<S, C extends Commands2<any>, E extends Events2<S, any>>(cmds: AggregateSpecification<S, C, E>): AggregateDeclaration<S, C, E> {
    const res = {};
    const cmd = cmds.commands || [];
    Object.keys(cmd).forEach((c) => (res[c] = (a: string) => cmd[c]));
    res['close'] = () => {
        return { payload: { remark: 'hello' } };
    };
    return res as AggregateDeclaration<S, C, E>;
}
