[**Redemeine API Reference**](../README.md)

***

[Redemeine API Reference](../README.md) / MixinSelectorsStage

# Interface: MixinSelectorsStage\<S, E, EOverrides\>

Defined in: [createMixin.ts:42](https://github.com/surikaterna/redemeine/blob/b5385f50ff070d36ff6e69e936f6843e8b07e4f9/src/createMixin.ts#L42)

## Type Parameters

### S

`S`

### E

`E`

### EOverrides

`EOverrides`

## Properties

### selectors

> **selectors**: \<`Selectors`\>(`selectors`) => [`MixinCommandsStage`](MixinCommandsStage.md)\<`S`, `E`, `EOverrides`, `Selectors`\>

Defined in: [createMixin.ts:49](https://github.com/surikaterna/redemeine/blob/b5385f50ff070d36ff6e69e936f6843e8b07e4f9/src/createMixin.ts#L49)

Define pure functions that slice and read from the state.

#### Type Parameters

##### Selectors

`Selectors` *extends* [`SelectorsMap`](../type-aliases/SelectorsMap.md)\<`S`\>

#### Parameters

##### selectors

`Selectors`

#### Returns

[`MixinCommandsStage`](MixinCommandsStage.md)\<`S`, `E`, `EOverrides`, `Selectors`\>

#### Example

```ts
.selectors({ getAuditCount: (state) => state.auditTrail.length })
```
