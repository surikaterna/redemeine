[**Redemeine API Reference**](../../README.md)

***

[Redemeine API Reference](../../README.md) / [\<internal\>](../README.md) / ExtractEntityCommands

# Type Alias: ExtractEntityCommands\<T\>

> **ExtractEntityCommands**\<`T`\> = `T` *extends* [`EntityPackage`](../../interfaces/EntityPackage.md)\<`any`, infer EName, `any`, `any`, infer CPayloads, `any`\> ? `` { [K in keyof CPayloads as K extends string ? `${EName}${Capitalize<K>}` : never]: CPayloads[K] } `` : `object`

Defined in: [createAggregateBuilder.ts:19](https://github.com/surikaterna/redemeine/blob/690161114c93099b83a558cc98f143d982e18c36/src/createAggregateBuilder.ts#L19)

## Type Parameters

### T

`T`
