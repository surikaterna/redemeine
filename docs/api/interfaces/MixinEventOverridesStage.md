[**Redemeine API Reference**](../README.md)

***

[Redemeine API Reference](../README.md) / MixinEventOverridesStage

# Interface: MixinEventOverridesStage\<S, E\>

Defined in: [createMixin.ts:36](https://github.com/surikaterna/redemeine/blob/b5385f50ff070d36ff6e69e936f6843e8b07e4f9/src/createMixin.ts#L36)

## Type Parameters

### S

`S`

### E

`E`

## Properties

### overrideEventNames

> **overrideEventNames**: \<`EOverrides`\>(`overrides`) => [`MixinSelectorsStage`](MixinSelectorsStage.md)\<`S`, `E`, `EOverrides`\>

Defined in: [createMixin.ts:37](https://github.com/surikaterna/redemeine/blob/b5385f50ff070d36ff6e69e936f6843e8b07e4f9/src/createMixin.ts#L37)

#### Type Parameters

##### EOverrides

`EOverrides` *extends* [`Partial`](https://www.typescriptlang.org/docs/handbook/utility-types.html#partialtype)\<[`Record`](https://www.typescriptlang.org/docs/handbook/utility-types.html#recordkeys-type)\<keyof `E`, `` `${string}.event` ``\>\>

#### Parameters

##### overrides

`EOverrides`

#### Returns

[`MixinSelectorsStage`](MixinSelectorsStage.md)\<`S`, `E`, `EOverrides`\>
