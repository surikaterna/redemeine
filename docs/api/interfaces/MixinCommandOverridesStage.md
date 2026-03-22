[**Redemeine API Reference**](../README.md)

***

[Redemeine API Reference](../README.md) / MixinCommandOverridesStage

# Interface: MixinCommandOverridesStage\<S, E, EOverrides, CPayloads, Selectors\>

Defined in: [createMixin.ts:71](https://github.com/surikaterna/redemeine/blob/690161114c93099b83a558cc98f143d982e18c36/src/createMixin.ts#L71)

## Type Parameters

### S

`S`

### E

`E`

### EOverrides

`EOverrides`

### CPayloads

`CPayloads`

### Selectors

`Selectors`

## Properties

### overrideCommandNames

> **overrideCommandNames**: \<`COverrides`\>(`overrides`) => `object`

Defined in: [createMixin.ts:72](https://github.com/surikaterna/redemeine/blob/690161114c93099b83a558cc98f143d982e18c36/src/createMixin.ts#L72)

#### Type Parameters

##### COverrides

`COverrides` *extends* [`Partial`](https://www.typescriptlang.org/docs/handbook/utility-types.html#partialtype)\<[`Record`](https://www.typescriptlang.org/docs/handbook/utility-types.html#recordkeys-type)\<keyof `CPayloads`, `` `${string}.command` ``\>\>

#### Parameters

##### overrides

`COverrides`

#### Returns

##### build

> **build**: () => [`MixinPackage`](MixinPackage.md)\<`S`, `E`, `EOverrides`, `CPayloads`, `COverrides`, `Selectors`\>

Finalizes and compiles the Mixin.

###### Returns

[`MixinPackage`](MixinPackage.md)\<`S`, `E`, `EOverrides`, `CPayloads`, `COverrides`, `Selectors`\>
