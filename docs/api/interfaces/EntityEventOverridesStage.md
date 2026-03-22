[**Redemeine API Reference**](../README.md)

***

[Redemeine API Reference](../README.md) / EntityEventOverridesStage

# Interface: EntityEventOverridesStage\<S, Name, E\>

Defined in: [createEntity.ts:37](https://github.com/surikaterna/redemeine/blob/b5385f50ff070d36ff6e69e936f6843e8b07e4f9/src/createEntity.ts#L37)

## Type Parameters

### S

`S`

### Name

`Name` *extends* `string`

### E

`E`

## Properties

### overrideEventNames

> **overrideEventNames**: \<`EOverrides`\>(`overrides`) => [`EntitySelectorsStage`](EntitySelectorsStage.md)\<`S`, `Name`, `E`, `EOverrides`\>

Defined in: [createEntity.ts:38](https://github.com/surikaterna/redemeine/blob/b5385f50ff070d36ff6e69e936f6843e8b07e4f9/src/createEntity.ts#L38)

#### Type Parameters

##### EOverrides

`EOverrides` *extends* [`Partial`](https://www.typescriptlang.org/docs/handbook/utility-types.html#partialtype)\<[`Record`](https://www.typescriptlang.org/docs/handbook/utility-types.html#recordkeys-type)\<keyof `E`, `` `${string}.event` ``\>\>

#### Parameters

##### overrides

`EOverrides`

#### Returns

[`EntitySelectorsStage`](EntitySelectorsStage.md)\<`S`, `Name`, `E`, `EOverrides`\>
