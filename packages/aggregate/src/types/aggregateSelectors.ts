type Keys<T> = T extends unknown ? keyof T : never;
type Value<T, K extends PropertyKey> = T extends unknown ? K extends keyof T ? T[K] : never : never;
type RequiredKeys<T> = { [K in keyof T]-?: {} extends Pick<T, K> ? never : K }[keyof T];

/** Object spread replaces required keys; optional writers retain the prior value. */
export type ReplaceSelectors<Root, Next> = Root extends unknown ? Next extends unknown ? {
    [K in RequiredKeys<Root> | RequiredKeys<Next>]: K extends RequiredKeys<Next>
        ? Value<Next, K> : Value<Root, K> | Exclude<Value<Next, K>, undefined>
} & {
    [K in Exclude<keyof Root | keyof Next, RequiredKeys<Root> | RequiredKeys<Next>>]?:
        Exclude<Value<Root, K> | Value<Next, K>, undefined>
} : never : never;

type MixinSelectors<T> = T extends { selectors?: infer Selectors }
    ? T extends { selectors: unknown }
        ? string extends keyof Selectors ? Partial<Selectors> : Selectors
        : Partial<Selectors>
    : {};

// An array may be empty, contain only one variant, or end with any member.
type PossibleSelectors<Root, Variants> = Root extends unknown ? {
    [K in keyof Root]: Root[K] | Exclude<Value<Variants, K>, undefined>
} & {
    [K in Exclude<Keys<Variants>, keyof Root>]?: Exclude<Value<Variants, K>, undefined>
} : never;

export type EffectiveSelectors<Root, Mixins extends readonly unknown[]> =
    Mixins extends readonly [infer Head, ...infer Tail]
        ? EffectiveSelectors<ReplaceSelectors<Root, MixinSelectors<Head>>, Tail>
        : Mixins extends readonly []
            ? Root
            : PossibleSelectors<Root, MixinSelectors<Mixins[number]>>;
