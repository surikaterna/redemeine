[**Redemeine API Reference**](../README.md)

***

[Redemeine API Reference](../README.md) / MixinEventsStage

# Interface: MixinEventsStage\<S\>

Defined in: [createMixin.ts:20](https://github.com/surikaterna/redemeine/blob/690161114c93099b83a558cc98f143d982e18c36/src/createMixin.ts#L20)

2. The Chaining Interfaces to guide the IDE

## Type Parameters

### S

`S`

## Properties

### events

> **events**: \<`E`\>(`events`) => [`MixinEventOverridesStage`](MixinEventOverridesStage.md)\<`S`, `E`\>

Defined in: [createMixin.ts:31](https://github.com/surikaterna/redemeine/blob/690161114c93099b83a558cc98f143d982e18c36/src/createMixin.ts#L31)

Register event handlers for this Mixin that apply state mutations.
**Magic:** The `state` object inside these handlers is wrapped in Immer. You CAN mutate it directly!
The auto-namer maps camelCase keys to dot notation automatically.

#### Type Parameters

##### E

`E` *extends* [`Record`](https://www.typescriptlang.org/docs/handbook/utility-types.html#recordkeys-type)\<`string`, (`state`, `event`) => `void`\>

#### Parameters

##### events

`E`

#### Returns

[`MixinEventOverridesStage`](MixinEventOverridesStage.md)\<`S`, `E`\>

#### Example

```ts
.events({
  auditLogged: (state, event) => { state.auditTrail.push(event.payload); }
})
```
