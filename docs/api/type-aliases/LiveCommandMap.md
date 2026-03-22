[**Redemeine API Reference**](../README.md)

***

[Redemeine API Reference](../README.md) / LiveCommandMap

# Type Alias: LiveCommandMap\<S, M\>

> **LiveCommandMap**\<`S`, `M`\> = \{ \[K in keyof M\]: \[M\[K\]\] extends \[void\] \| \[undefined\] \| \[never\] ? () =\> Promise\<S\> : (payload: M\[K\]) =\> Promise\<S\> \}

Defined in: [createLiveAggregate.ts:16](https://github.com/surikaterna/redemeine/blob/b5385f50ff070d36ff6e69e936f6843e8b07e4f9/src/createLiveAggregate.ts#L16)

## Type Parameters

### S

`S`

### M

`M`
