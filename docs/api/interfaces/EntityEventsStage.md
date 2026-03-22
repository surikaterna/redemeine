[**Redemeine API Reference**](../README.md)

***

[Redemeine API Reference](../README.md) / EntityEventsStage

# Interface: EntityEventsStage\<S, Name\>

Defined in: [createEntity.ts:21](https://github.com/surikaterna/redemeine/blob/b5385f50ff070d36ff6e69e936f6843e8b07e4f9/src/createEntity.ts#L21)

2. The Chaining Interfaces to guide the IDE

## Type Parameters

### S

`S`

### Name

`Name` *extends* `string`

## Properties

### events

> **events**: \<`E`\>(`events`) => [`EntityEventOverridesStage`](EntityEventOverridesStage.md)\<`S`, `Name`, `E`\>

Defined in: [createEntity.ts:32](https://github.com/surikaterna/redemeine/blob/b5385f50ff070d36ff6e69e936f6843e8b07e4f9/src/createEntity.ts#L32)

Register state-altering event handlers for this Entity.
**Magic:** The `state` object inside these handlers is wrapped in Immer. You CAN mutate it directly!
The targeted auto-namer maps camelCase keys to dot notation combined with the parent aggregate's namespace (e.g. `aggregate.entity.item_added.event`).

#### Type Parameters

##### E

`E` *extends* [`Record`](https://www.typescriptlang.org/docs/handbook/utility-types.html#recordkeys-type)\<`string`, (`state`, `event`) => `void`\>

#### Parameters

##### events

`E`

#### Returns

[`EntityEventOverridesStage`](EntityEventOverridesStage.md)\<`S`, `Name`, `E`\>

#### Example

```ts
.events({
  lineAdded: (state, event) => { state.lines.push(event.payload); }
})
```
