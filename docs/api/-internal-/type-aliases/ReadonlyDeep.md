[**Redemeine API Reference**](../../README.md)

***

[Redemeine API Reference](../../README.md) / [\<internal\>](../README.md) / ReadonlyDeep

# Type Alias: ReadonlyDeep\<T\>

> **ReadonlyDeep**\<`T`\> = `{ readonly [P in keyof T]: T[P] extends object ? ReadonlyDeep<T[P]> : T[P] }`

Defined in: [utils/types/ReadonlyDeep.ts:1](https://github.com/surikaterna/redemeine/blob/690161114c93099b83a558cc98f143d982e18c36/src/utils/types/ReadonlyDeep.ts#L1)

## Type Parameters

### T

`T`
