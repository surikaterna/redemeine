[**Redemeine API Reference**](../README.md)

***

[Redemeine API Reference](../README.md) / CommandFactory

# Type Alias: CommandFactory\<P, T\>

> **CommandFactory**\<`P`, `T`\> = (`payload`) => [`Command`](../interfaces/Command.md)\<`P`, `T`\> & `object`

Defined in: [createCommand.ts:5](https://github.com/surikaterna/redemeine/blob/690161114c93099b83a558cc98f143d982e18c36/src/createCommand.ts#L5)

## Type Declaration

### toString

> **toString**: () => `T`

#### Returns

`T`

### type

> **type**: `T`

## Type Parameters

### P

`P` = `void`

### T

`T` *extends* [`CommandType`](CommandType.md) \| `string` = [`CommandType`](CommandType.md)
