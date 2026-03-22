[**Redemeine API Reference**](../README.md)

***

[Redemeine API Reference](../README.md) / EntitySelectorsStage

# Interface: EntitySelectorsStage\<S, Name, E, EOverrides\>

Defined in: [createEntity.ts:43](https://github.com/surikaterna/redemeine/blob/b5385f50ff070d36ff6e69e936f6843e8b07e4f9/src/createEntity.ts#L43)

## Type Parameters

### S

`S`

### Name

`Name` *extends* `string`

### E

`E`

### EOverrides

`EOverrides`

## Properties

### selectors

> **selectors**: \<`Selectors`\>(`selectors`) => [`EntityCommandsStage`](EntityCommandsStage.md)\<`S`, `Name`, `E`, `EOverrides`, `Selectors`\>

Defined in: [createEntity.ts:53](https://github.com/surikaterna/redemeine/blob/b5385f50ff070d36ff6e69e936f6843e8b07e4f9/src/createEntity.ts#L53)

Define pure functions scoped only to this entity's structure.
These will be injectable into your command handlers via the `context` parameter.

#### Type Parameters

##### Selectors

`Selectors` *extends* [`SelectorsMap`](../type-aliases/SelectorsMap.md)\<`S`\>

#### Parameters

##### selectors

`Selectors`

#### Returns

[`EntityCommandsStage`](EntityCommandsStage.md)\<`S`, `Name`, `E`, `EOverrides`, `Selectors`\>

#### Example

```ts
.selectors({
  isLineValid: (state) => state.quantity > 0
})
```
