[**Redemeine API Reference**](../README.md)

***

[Redemeine API Reference](../README.md) / createLiveAggregate

# Function: createLiveAggregate()

> **createLiveAggregate**\<`S`, `Name`, `M`\>(`builder`, `id`, `initialState?`, `options?`): [`LiveCommandMap`](../type-aliases/LiveCommandMap.md)\<`S`, `M`\> & [`Readonly`](https://www.typescriptlang.org/docs/handbook/utility-types.html#readonlytype)\<`S`\> & [`Record`](https://www.typescriptlang.org/docs/handbook/utility-types.html#recordkeys-type)\<`string`, `any`\>

Defined in: [createLiveAggregate.ts:42](https://github.com/surikaterna/redemeine/blob/690161114c93099b83a558cc98f143d982e18c36/src/createLiveAggregate.ts#L42)

## Type Parameters

### S

`S` *extends* `object`

### Name

`Name` *extends* `string`

### M

`M` *extends* [`Record`](https://www.typescriptlang.org/docs/handbook/utility-types.html#recordkeys-type)\<`string`, `any`\>

## Parameters

### builder

[`BuiltAggregate`](../interfaces/BuiltAggregate.md)\<`S`, `M`\>

### id

`string`

### initialState?

`S`

### options?

[`LiveAggregateOptions`](../interfaces/LiveAggregateOptions.md)

## Returns

[`LiveCommandMap`](../type-aliases/LiveCommandMap.md)\<`S`, `M`\> & [`Readonly`](https://www.typescriptlang.org/docs/handbook/utility-types.html#readonlytype)\<`S`\> & [`Record`](https://www.typescriptlang.org/docs/handbook/utility-types.html#recordkeys-type)\<`string`, `any`\>
