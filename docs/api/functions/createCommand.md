[**Redemeine API Reference**](../README.md)

***

[Redemeine API Reference](../README.md) / createCommand

# Function: createCommand()

## Call Signature

> **createCommand**\<`P`, `T`\>(`type`): [`CommandFactory`](../type-aliases/CommandFactory.md)\<`P`, `T`\>

Defined in: [createCommand.ts:11](https://github.com/surikaterna/redemeine/blob/b5385f50ff070d36ff6e69e936f6843e8b07e4f9/src/createCommand.ts#L11)

### Type Parameters

#### P

`P` = `void`

#### T

`T` *extends* `string` = `` `${string}.command` ``

### Parameters

#### type

`T`

### Returns

[`CommandFactory`](../type-aliases/CommandFactory.md)\<`P`, `T`\>

## Call Signature

> **createCommand**\<`PC`, `T`\>(`type`, `prepareCommand`): [`PreparedCommandFactory`](../type-aliases/PreparedCommandFactory.md)\<`PC`, `T`\>

Defined in: [createCommand.ts:12](https://github.com/surikaterna/redemeine/blob/b5385f50ff070d36ff6e69e936f6843e8b07e4f9/src/createCommand.ts#L12)

### Type Parameters

#### PC

`PC` *extends* [`PrepareCommand`](../type-aliases/PrepareCommand.md)\<`any`\>

#### T

`T` *extends* `string` = `` `${string}.command` ``

### Parameters

#### type

`T`

#### prepareCommand

`PC`

### Returns

[`PreparedCommandFactory`](../type-aliases/PreparedCommandFactory.md)\<`PC`, `T`\>
