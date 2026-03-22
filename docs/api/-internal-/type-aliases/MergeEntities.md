[**Redemeine API Reference**](../../README.md)

***

[Redemeine API Reference](../../README.md) / [\<internal\>](../README.md) / MergeEntities

# Type Alias: MergeEntities\<T\>

> **MergeEntities**\<`T`\> = `T` *extends* \[infer First, `...(infer Rest)`\] ? [`ExtractEntityCommands`](ExtractEntityCommands.md)\<`First`\> & `MergeEntities`\<`Rest`\> : `object`

Defined in: [createAggregateBuilder.ts:23](https://github.com/surikaterna/redemeine/blob/690161114c93099b83a558cc98f143d982e18c36/src/createAggregateBuilder.ts#L23)

## Type Parameters

### T

`T` *extends* `any`[]
