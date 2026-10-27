export type ListIdentity<PK, _Name extends string> = PK extends readonly (infer K extends string)[] ? K
    : PK extends string ? PK : 'id';
export type MapIdentity<_Name extends string> = 'key';
export type InjectedArgCount<PK> = PK extends readonly unknown[] ? PK['length'] : 1;

type DropFirstN<Args extends unknown[], N extends number, Count extends unknown[] = []> =
    Count['length'] extends N ? Args
        : Args extends [unknown, ...infer Rest] ? DropFirstN<Rest, N, [...Count, unknown]> : [];

type UnsupportedPayload<P> = P extends undefined ? never
    : P extends readonly unknown[] | ((...args: never[]) => unknown) ? P
    : P extends object ? never : P;
type OmitIdentity<P, Identity extends PropertyKey> = P extends object ? Omit<P, Identity> : never;
type ScopedPayloadArgs<Args extends unknown[], Identity extends PropertyKey> = Args extends [] ? []
    : [UnsupportedPayload<Args[0]>] extends [never]
        ? [Exclude<Args[0], undefined>] extends [never] ? Args
            : number extends Args['length'] ? never
            : 0 extends Args['length'] ? [payload?: OmitIdentity<Args[0], Identity>]
            : {} extends OmitIdentity<Args[0], Identity>
                ? [payload?: OmitIdentity<Args[0], Identity>]
                : [payload: OmitIdentity<Args[0], Identity> | Extract<Args[0], undefined>]
        : never;

type CommandIdentity<C, Fallback extends PropertyKey> = C extends { readonly __registration: infer R }
    ? R extends { kind: 'list'; pk: infer PK; mountName: infer Name extends string } ? ListIdentity<PK, Name>
        : R extends { kind: 'map'; mountName: infer Name extends string } ? MapIdentity<Name> : Fallback
    : Fallback;
type CommandArgCount<C, Fallback extends number> = C extends { readonly __registration: { pk: infer PK } }
    ? InjectedArgCount<PK> : Fallback;

export type ScopedCommandArgs<C, Args extends unknown[], Count extends number, Identity extends PropertyKey> =
    C extends { form: 'shorthand' } ? ScopedPayloadArgs<Args, CommandIdentity<C, Identity>>
        : DropFirstN<Args, CommandArgCount<C, Count>>;
