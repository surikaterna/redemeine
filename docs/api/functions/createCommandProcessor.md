[**Redemeine API Reference**](../README.md)

***

[Redemeine API Reference](../README.md) / createCommandProcessor

# Function: createCommandProcessor()

> **createCommandProcessor**\<`S`\>(`aggregateName`, `allCommandsMap`, `allCommandOverrides`): (`state`, `command`) => [`Event`](../interfaces/Event.md)\<`any`, `` `${string}.event` ``\>[]

Defined in: [createCommandProcessor.ts:5](https://github.com/surikaterna/redemeine/blob/690161114c93099b83a558cc98f143d982e18c36/src/createCommandProcessor.ts#L5)

## Type Parameters

### S

`S`

## Parameters

### aggregateName

`string`

### allCommandsMap

[`Record`](https://www.typescriptlang.org/docs/handbook/utility-types.html#recordkeys-type)\<`string`, [`Function`](https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/Function)\>

### allCommandOverrides

[`Record`](https://www.typescriptlang.org/docs/handbook/utility-types.html#recordkeys-type)\<`string`, `string`\>

## Returns

(`state`, `command`) => [`Event`](../interfaces/Event.md)\<`any`, `` `${string}.event` ``\>[]
