[**Redemeine API Reference**](../README.md)

***

[Redemeine API Reference](../README.md) / EntityPackage

# Interface: EntityPackage\<S, Name, E, EOverrides, CPayloads, COverrides, Selectors\>

Defined in: [createEntity.ts:9](https://github.com/surikaterna/redemeine/blob/690161114c93099b83a558cc98f143d982e18c36/src/createEntity.ts#L9)

A compiled Entity ready to be injected into an AggregateBuilder via `.entities()`.
Maintains its own namespace and isolated lifecycle logic.

## Type Parameters

### S

`S`

### Name

`Name` *extends* `string`

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

Defined in: [createEntity.ts:14](https://github.com/surikaterna/redemeine/blob/690161114c93099b83a558cc98f143d982e18c36/src/createEntity.ts#L14)

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

Defined in: [createEntity.ts:17](https://github.com/surikaterna/redemeine/blob/690161114c93099b83a558cc98f143d982e18c36/src/createEntity.ts#L17)

***

### eventOverrides

> **eventOverrides**: `EOverrides`

Defined in: [createEntity.ts:12](https://github.com/surikaterna/redemeine/blob/690161114c93099b83a558cc98f143d982e18c36/src/createEntity.ts#L12)

***

### events

> **events**: `E`

Defined in: [createEntity.ts:11](https://github.com/surikaterna/redemeine/blob/690161114c93099b83a558cc98f143d982e18c36/src/createEntity.ts#L11)

***

### name

> **name**: `Name`

Defined in: [createEntity.ts:10](https://github.com/surikaterna/redemeine/blob/690161114c93099b83a558cc98f143d982e18c36/src/createEntity.ts#L10)

***

### selectors

> **selectors**: [`SelectorsMap`](../type-aliases/SelectorsMap.md)\<`S`\>

Defined in: [createEntity.ts:13](https://github.com/surikaterna/redemeine/blob/690161114c93099b83a558cc98f143d982e18c36/src/createEntity.ts#L13)
