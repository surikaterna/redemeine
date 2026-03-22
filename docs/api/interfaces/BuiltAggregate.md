[**Redemeine API Reference**](../README.md)

***

[Redemeine API Reference](../README.md) / BuiltAggregate

# Interface: BuiltAggregate\<S, M\>

Defined in: [createLiveAggregate.ts:5](https://github.com/surikaterna/redemeine/blob/b5385f50ff070d36ff6e69e936f6843e8b07e4f9/src/createLiveAggregate.ts#L5)

## Type Parameters

### S

`S`

### M

`M`

## Properties

### apply

> **apply**: (`state`, `event`) => `S`

Defined in: [createLiveAggregate.ts:8](https://github.com/surikaterna/redemeine/blob/b5385f50ff070d36ff6e69e936f6843e8b07e4f9/src/createLiveAggregate.ts#L8)

#### Parameters

##### state

`S`

##### event

[`Event`](Event.md)

#### Returns

`S`

***

### commandCreators

> **commandCreators**: \{ \[K in string \| number \| symbol\]: \[M\[K\]\] extends \[void\] \| \[undefined\] \| \[never\] ? () =\> Command\<void, string\> : (payload: M\[K\]) =\> Command\<M\[K\], string\> \}

Defined in: [createLiveAggregate.ts:9](https://github.com/surikaterna/redemeine/blob/b5385f50ff070d36ff6e69e936f6843e8b07e4f9/src/createLiveAggregate.ts#L9)

***

### initialState

> **initialState**: `S`

Defined in: [createLiveAggregate.ts:6](https://github.com/surikaterna/redemeine/blob/b5385f50ff070d36ff6e69e936f6843e8b07e4f9/src/createLiveAggregate.ts#L6)

***

### process

> **process**: (`state`, `command`) => [`Event`](Event.md)\<`any`, `` `${string}.event` ``\>[]

Defined in: [createLiveAggregate.ts:7](https://github.com/surikaterna/redemeine/blob/b5385f50ff070d36ff6e69e936f6843e8b07e4f9/src/createLiveAggregate.ts#L7)

#### Parameters

##### state

`S`

##### command

[`Command`](Command.md)\<`any`, `string`\>

#### Returns

[`Event`](Event.md)\<`any`, `` `${string}.event` ``\>[]
