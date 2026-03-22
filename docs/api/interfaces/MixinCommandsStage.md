[**Redemeine API Reference**](../README.md)

***

[Redemeine API Reference](../README.md) / MixinCommandsStage

# Interface: MixinCommandsStage\<S, E, EOverrides, Selectors\>

Defined in: [createMixin.ts:54](https://github.com/surikaterna/redemeine/blob/690161114c93099b83a558cc98f143d982e18c36/src/createMixin.ts#L54)

## Type Parameters

### S

`S`

### E

`E`

### EOverrides

`EOverrides`

### Selectors

`Selectors`

## Properties

### commands

> **commands**: \<`CPayloads`\>(`factory`) => [`MixinCommandOverridesStage`](MixinCommandOverridesStage.md)\<`S`, `E`, `EOverrides`, `CPayloads`, `Selectors`\>

Defined in: [createMixin.ts:64](https://github.com/surikaterna/redemeine/blob/690161114c93099b83a558cc98f143d982e18c36/src/createMixin.ts#L64)

Define command processors containing business rules.
**Magic:** The `state` provided here is strictly `ReadonlyDeep`. State MUST NOT be mutated in commands, only within `.events()`.

#### Type Parameters

##### CPayloads

`CPayloads` *extends* [`Record`](https://www.typescriptlang.org/docs/handbook/utility-types.html#recordkeys-type)\<`string`, `any`\>

#### Parameters

##### factory

(`emit`, `context`) => \{ \[K in string \| number \| symbol\]: (state: ReadonlyDeep\<S\>, payload: CPayloads\[K\]) =\> Event\<any, any\> \| Event\<any, any\>\[\] \}

#### Returns

[`MixinCommandOverridesStage`](MixinCommandOverridesStage.md)\<`S`, `E`, `EOverrides`, `CPayloads`, `Selectors`\>

#### Example

```ts
.commands((emit, ctx) => ({
  logAudit: (state, payload: { msg: string }) => emit('auditLogged', payload)
}))
```
