export type NestedPairsOf<T, S> = T extends S
    ? never
    : {
        [K in keyof T]: T[K] extends S ? { [J in K]: T[J] } : NestedPairsOf<T[K], S>;
    }[keyof T];