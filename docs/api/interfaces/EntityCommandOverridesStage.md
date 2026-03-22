[**Redemeine API Reference**](../README.md)

***

[Redemeine API Reference](../README.md) / EntityCommandOverridesStage

# Interface: EntityCommandOverridesStage\<S, Name, E, EOverrides, CPayloads, Selectors\>

Defined in: [createEntity.ts:79](https://github.com/surikaterna/redemeine/blob/690161114c93099b83a558cc98f143d982e18c36/src/createEntity.ts#L79)

## Type Parameters

### S

`S`

### Name

`Name` *extends* `string`

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

Defined in: [createEntity.ts:80](https://github.com/surikaterna/redemeine/blob/690161114c93099b83a558cc98f143d982e18c36/src/createEntity.ts#L80)

#### Type Parameters

##### COverrides

`COverrides` *extends* [`Partial`](https://www.typescriptlang.org/docs/handbook/utility-types.html#partialtype)\<[`Record`](https://www.typescriptlang.org/docs/handbook/utility-types.html#recordkeys-type)\<keyof `CPayloads`, `` `${string}.command` ``\>\>

#### Parameters

##### overrides

`COverrides`

#### Returns

##### build

> **build**: () => [`EntityPackage`](EntityPackage.md)\<`S`, `Name`, `E`, `EOverrides`, `CPayloads`, `COverrides`, `Selectors`\>

Finalizes and compiles the Entity into a pluggable package.

###### Returns

[`EntityPackage`](EntityPackage.md)\<`S`, `Name`, `E`, `EOverrides`, `CPayloads`, `COverrides`, `Selectors`\>
