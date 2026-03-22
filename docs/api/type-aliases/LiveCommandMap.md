[**Redemeine API Reference**](../README.md)

***

[Redemeine API Reference](../README.md) / LiveCommandMap

# Type Alias: LiveCommandMap\<S, M\>

> **LiveCommandMap**\<`S`, `M`\> = \{ \[K in keyof M\]: \[M\[K\]\] extends \[void\] \| \[undefined\] \| \[never\] ? () =\> Promise\<S\> : (payload: M\[K\]) =\> Promise\<S\> \}

Defined in: [createLiveAggregate.ts:16](https://github.com/surikaterna/redemeine/blob/690161114c93099b83a558cc98f143d982e18c36/src/createLiveAggregate.ts#L16)

## Type Parameters

### S

`S`

### M

`M`
