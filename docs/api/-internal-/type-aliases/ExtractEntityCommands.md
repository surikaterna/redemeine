[**Redemeine API Reference**](../../README.md)

***

[Redemeine API Reference](../../README.md) / [\<internal\>](../README.md) / ExtractEntityCommands

# Type Alias: ExtractEntityCommands\<T\>

> **ExtractEntityCommands**\<`T`\> = `T` *extends* [`EntityPackage`](../../interfaces/EntityPackage.md)\<`any`, infer EName, `any`, `any`, infer CPayloads, `any`\> ? `` { [K in keyof CPayloads as K extends string ? `${EName}${Capitalize<K>}` : never]: CPayloads[K] } `` : `object`

Defined in: [createAggregateBuilder.ts:19](https://github.com/surikaterna/redemeine/blob/b5385f50ff070d36ff6e69e936f6843e8b07e4f9/src/createAggregateBuilder.ts#L19)

## Type Parameters

### T

`T`
