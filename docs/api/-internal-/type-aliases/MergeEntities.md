[**Redemeine API Reference**](../../README.md)

***

[Redemeine API Reference](../../README.md) / [\<internal\>](../README.md) / MergeEntities

# Type Alias: MergeEntities\<T\>

> **MergeEntities**\<`T`\> = `T` *extends* \[infer First, `...(infer Rest)`\] ? [`ExtractEntityCommands`](ExtractEntityCommands.md)\<`First`\> & `MergeEntities`\<`Rest`\> : `object`

Defined in: [createAggregateBuilder.ts:23](https://github.com/surikaterna/redemeine/blob/b5385f50ff070d36ff6e69e936f6843e8b07e4f9/src/createAggregateBuilder.ts#L23)

## Type Parameters

### T

`T` *extends* `any`[]
