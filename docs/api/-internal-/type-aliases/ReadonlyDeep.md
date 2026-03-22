[**Redemeine API Reference**](../../README.md)

***

[Redemeine API Reference](../../README.md) / [\<internal\>](../README.md) / ReadonlyDeep

# Type Alias: ReadonlyDeep\<T\>

> **ReadonlyDeep**\<`T`\> = `{ readonly [P in keyof T]: T[P] extends object ? ReadonlyDeep<T[P]> : T[P] }`

Defined in: [utils/types/ReadonlyDeep.ts:1](https://github.com/surikaterna/redemeine/blob/b5385f50ff070d36ff6e69e936f6843e8b07e4f9/src/utils/types/ReadonlyDeep.ts#L1)

## Type Parameters

### T

`T`
