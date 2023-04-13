import { type AllKeys } from "./AllKeys";

export type PickType<T, K extends AllKeys<T>> = T extends { [k in K]?: any }
    ? T[K]
    : never;