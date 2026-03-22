[**Redemeine API Reference**](../README.md)

***

[Redemeine API Reference](../README.md) / EntityCommandsStage

# Interface: EntityCommandsStage\<S, Name, E, EOverrides, Selectors\>

Defined in: [createEntity.ts:58](https://github.com/surikaterna/redemeine/blob/690161114c93099b83a558cc98f143d982e18c36/src/createEntity.ts#L58)

## Type Parameters

### S

`S`

### Name

`Name` *extends* `string`

### E

`E`

### EOverrides

`EOverrides`

### Selectors

`Selectors`

## Properties

### commands

> **commands**: \<`CPayloads`\>(`factory`) => [`EntityCommandOverridesStage`](EntityCommandOverridesStage.md)\<`S`, `Name`, `E`, `EOverrides`, `CPayloads`, `Selectors`\>

Defined in: [createEntity.ts:72](https://github.com/surikaterna/redemeine/blob/690161114c93099b83a558cc98f143d982e18c36/src/createEntity.ts#L72)

Define scoped command processors that execute business logic.
**Magic:** The `state` provided here is strictly `ReadonlyDeep`. State MUST NOT be mutated in commands.
The auto-namer evaluates camelCase keys with the entity's namespace (e.g. `cancelLine` -> `aggregate.entity.cancel_line.command`).

#### Type Parameters

##### CPayloads

`CPayloads` *extends* [`Record`](https://www.typescriptlang.org/docs/handbook/utility-types.html#recordkeys-type)\<`string`, `any`\>

#### Parameters

##### factory

(`emit`, `context`) => \{ \[K in string \| number \| symbol\]: (state: ReadonlyDeep\<S\>, payload: CPayloads\[K\]) =\> Event\<any, any\> \| Event\<any, any\>\[\] \}

#### Returns

[`EntityCommandOverridesStage`](EntityCommandOverridesStage.md)\<`S`, `Name`, `E`, `EOverrides`, `CPayloads`, `Selectors`\>

#### Example

```ts
.commands((emit, ctx) => ({
  cancelLine: (state, payload: { reason: string }) => {
     if (ctx.selectors.isLineValid(state)) return emit('lineCancelled', payload);
     throw new Error("Invalid");
  }
}))
```
