[**Redemeine API Reference**](../README.md)

***

[Redemeine API Reference](../README.md) / MixinPackage

# Interface: MixinPackage\<S, E, EOverrides, CPayloads, COverrides, Selectors\>

Defined in: [createMixin.ts:9](https://github.com/surikaterna/redemeine/blob/b5385f50ff070d36ff6e69e936f6843e8b07e4f9/src/createMixin.ts#L9)

A compiled reusable piece of domain logic (Commands, Events, Selectors)
ready to be embedded horizontally into an AggregateBuilder via `.mixins()`.

## Type Parameters

### S

`S`

### E

`E` = `any`

### EOverrides

`EOverrides` = `any`

### CPayloads

`CPayloads` = `any`

### COverrides

`COverrides` = `any`

### Selectors

`Selectors` = `any`

## Properties

### commandFactory

> **commandFactory**: (`emit`, `context`) => \{ \[K in string \| number \| symbol\]: (state: ReadonlyDeep\<S\>, payload: CPayloads\[K\]) =\> Event\<any, any\> \| Event\<any, any\>\[\] \}

Defined in: [createMixin.ts:12](https://github.com/surikaterna/redemeine/blob/b5385f50ff070d36ff6e69e936f6843e8b07e4f9/src/createMixin.ts#L12)

#### Parameters

##### emit

`any`

##### context

###### selectors

[`SelectorsMap`](../type-aliases/SelectorsMap.md)\<`S`\>

#### Returns

\{ \[K in string \| number \| symbol\]: (state: ReadonlyDeep\<S\>, payload: CPayloads\[K\]) =\> Event\<any, any\> \| Event\<any, any\>\[\] \}

***

### commandOverrides

> **commandOverrides**: `COverrides`

Defined in: [createMixin.ts:15](https://github.com/surikaterna/redemeine/blob/b5385f50ff070d36ff6e69e936f6843e8b07e4f9/src/createMixin.ts#L15)

***

### eventOverrides

> **eventOverrides**: `EOverrides`

Defined in: [createMixin.ts:11](https://github.com/surikaterna/redemeine/blob/b5385f50ff070d36ff6e69e936f6843e8b07e4f9/src/createMixin.ts#L11)

***

### events

> **events**: `E`

Defined in: [createMixin.ts:10](https://github.com/surikaterna/redemeine/blob/b5385f50ff070d36ff6e69e936f6843e8b07e4f9/src/createMixin.ts#L10)

***

### selectors

> **selectors**: [`SelectorsMap`](../type-aliases/SelectorsMap.md)\<`S`\>

Defined in: [createMixin.ts:16](https://github.com/surikaterna/redemeine/blob/b5385f50ff070d36ff6e69e936f6843e8b07e4f9/src/createMixin.ts#L16)
