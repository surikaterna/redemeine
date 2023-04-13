import type { AllKeys } from "./AllKeys";
import type { PickType } from "./PickType";

export type Merge<T extends object> = {
    [k in AllKeys<T>]: PickType<T, k>;
};