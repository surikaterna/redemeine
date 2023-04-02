type ApplyFunction<S = any, A = any> = (state: S, action: A) => void;

type AggregateApplyers<State> = {
    [K: string]: ApplyFunction<State, any>
}

interface AggregateDefinition<State = any> {
    name: string,
    initialState: State | (() => State),
    applyers: AggregateApplyers<State>
};

type WrappedApplyFunction<A = any> = (action: A) => void;


type Aggregate<State, AP extends AggregateApplyers<State>> = {
    [K in keyof AP]: () => void
} & {
    name: string,
    initialState: State | (() => State),
};

const wrapApplyer = <S, A>(applyer: ApplyFunction<S, A>) => {
    return (a: A) => { applyer(null as S, a) };
}

const createAggregate = <State, AA extends AggregateApplyers<State>>(def: AggregateDefinition<State>): Aggregate<State, AA> => {
    const res = Object.keys(def.applyers).map(key => { return { [key]: wrapApplyer(def.applyers[key]) } });
    const initialState = def.initialState;

    return {
        name: def.name,
        initialState,
        cancel: <A>(a: A) => { def.applyers.cancel({} as State, a); }
    } as Aggregate<State, AA>;
};

export { createAggregate };