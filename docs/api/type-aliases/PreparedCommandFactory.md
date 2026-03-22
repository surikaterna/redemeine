[**Redemeine API Reference**](../README.md)

***

[Redemeine API Reference](../README.md) / PreparedCommandFactory

# Type Alias: PreparedCommandFactory\<PC, T\>

> **PreparedCommandFactory**\<`PC`, `T`\> = (...`args`) => [`Command`](../interfaces/Command.md)\<[`ReturnType`](https://www.typescriptlang.org/docs/handbook/utility-types.html#returntypetype)\<`PC`\>\[`"payload"`\], `T`\> & `object`

Defined in: [createCommand.ts:8](https://github.com/surikaterna/redemeine/blob/b5385f50ff070d36ff6e69e936f6843e8b07e4f9/src/createCommand.ts#L8)

## Type Declaration

### toString

> **toString**: () => `T`

#### Returns

`T`

### type

> **type**: `T`

## Type Parameters

### PC

`PC` *extends* [`PrepareCommand`](PrepareCommand.md)\<`any`\>

### T

`T` *extends* [`CommandType`](CommandType.md) \| `string` = [`CommandType`](CommandType.md)
