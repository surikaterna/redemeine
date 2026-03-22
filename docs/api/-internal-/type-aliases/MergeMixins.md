[**Redemeine API Reference**](../../README.md)

***

[Redemeine API Reference](../../README.md) / [\<internal\>](../README.md) / MergeMixins

# Type Alias: MergeMixins\<T\>

> **MergeMixins**\<`T`\> = `T` *extends* \[infer First, `...(infer Rest)`\] ? [`ExtractMixinCommands`](ExtractMixinCommands.md)\<`First`\> & `MergeMixins`\<`Rest`\> : `object`

Defined in: [createAggregateBuilder.ts:15](https://github.com/surikaterna/redemeine/blob/b5385f50ff070d36ff6e69e936f6843e8b07e4f9/src/createAggregateBuilder.ts#L15)

Recursively merges an array of mixins into a single Command map

## Type Parameters

### T

`T` *extends* `any`[]
