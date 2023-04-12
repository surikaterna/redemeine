export type NestedKeysOf<T, S> = T extends S
    ? never
    : {
        [K in keyof T]: T[K] extends S ? K : NestedKeysOf<T[K], S>;
    }[keyof T & string];