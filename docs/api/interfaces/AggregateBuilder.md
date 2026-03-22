[**Redemeine API Reference**](../README.md)

***

[Redemeine API Reference](../README.md) / AggregateBuilder

# Interface: AggregateBuilder\<S, Name, M, E, EOverrides, Sel\>

Defined in: [createAggregateBuilder.ts:31](https://github.com/surikaterna/redemeine/blob/690161114c93099b83a558cc98f143d982e18c36/src/createAggregateBuilder.ts#L31)

The core builder interface for composing Aggregates in Redemeine.
Uses a fluent chained API to progressively layer events, commands, mixins, and entities.

## Type Parameters

### S

`S`

### Name

`Name` *extends* `string`

### M

`M` = \{ \}

### E

`E` = \{ \}

### EOverrides

`EOverrides` = \{ \}

### Sel

`Sel` = \{ \}

## Properties

### \_state

> **\_state**: `object`

Defined in: [createAggregateBuilder.ts:136](https://github.com/surikaterna/redemeine/blob/690161114c93099b83a558cc98f143d982e18c36/src/createAggregateBuilder.ts#L136)

Internal state for inheritance

#### commandOverrides

> **commandOverrides**: [`Record`](https://www.typescriptlang.org/docs/handbook/utility-types.html#recordkeys-type)\<`string`, `string`\>

#### commandsFactory

> **commandsFactory**: (`emit`, `context`) => [`Record`](https://www.typescriptlang.org/docs/handbook/utility-types.html#recordkeys-type)\<`string`, [`Function`](https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/Function)\>

##### Parameters

###### emit

`any`

###### context

###### selectors

`any`

##### Returns

[`Record`](https://www.typescriptlang.org/docs/handbook/utility-types.html#recordkeys-type)\<`string`, [`Function`](https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/Function)\>

#### eventOverrides

> **eventOverrides**: [`Record`](https://www.typescriptlang.org/docs/handbook/utility-types.html#recordkeys-type)\<`string`, `string`\>

#### events

> **events**: [`Record`](https://www.typescriptlang.org/docs/handbook/utility-types.html#recordkeys-type)\<`string`, [`Function`](https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/Function)\>

#### mixins

> **mixins**: [`MixinPackage`](MixinPackage.md)\<`S`, `any`, `any`, `any`, `any`, `any`\>[]

#### selectors

> **selectors**: [`Record`](https://www.typescriptlang.org/docs/handbook/utility-types.html#recordkeys-type)\<`string`, [`Function`](https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/Function)\>

***

### build

> **build**: () => `object`

Defined in: [createAggregateBuilder.ts:123](https://github.com/surikaterna/redemeine/blob/690161114c93099b83a558cc98f143d982e18c36/src/createAggregateBuilder.ts#L123)

Finalizes and compiles the aggregate.

#### Returns

`object`

##### apply

> **apply**: (`state`, `event`) => `S`

###### Parameters

###### state

`S`

###### event

[`Event`](Event.md)

###### Returns

`S`

##### commandCreators

> **commandCreators**: \{ \[K in string \| number \| symbol\]: \[M\[K\]\] extends \[void\] \| \[undefined\] ? () =\> \{ payload: void; type: string \} : (payload: M\[K\]) =\> \{ payload: M\[K\]; type: string \} \}

##### initialState

> **initialState**: `S`

##### process

> **process**: (`state`, `command`) => [`Event`](Event.md)\<`any`, `` `${string}.event` ``\>[]

###### Parameters

###### state

`S`

###### command

[`Command`](Command.md)\<`any`, `string`\>

###### Returns

[`Event`](Event.md)\<`any`, `` `${string}.event` ``\>[]

##### selectors

> **selectors**: `Sel`

***

### commands

> **commands**: \<`C`\>(`factory`) => `AggregateBuilder`\<`S`, `Name`, `M` & \{ \[K in string \| number \| symbol\]: Parameters\<C\[K\]\>\[1\] \}, `E`, `EOverrides`, `Sel`\>

Defined in: [createAggregateBuilder.ts:113](https://github.com/surikaterna/redemeine/blob/690161114c93099b83a558cc98f143d982e18c36/src/createAggregateBuilder.ts#L113)

Define command processors that execute business logic and emit events.
**Magic:** The `state` provided here is strictly `ReadonlyDeep`. State MUST NOT be mutated in commands, only within `.events()`.
The auto-namer evaluates camelCase keys (e.g. `dispatchShipment` -> `aggregate.dispatch_shipment.command`).

#### Type Parameters

##### C

`C` *extends* [`Record`](https://www.typescriptlang.org/docs/handbook/utility-types.html#recordkeys-type)\<`string`, (`state`, `payload`) => [`Event`](Event.md)\<`any`, `any`\> \| [`Event`](Event.md)\<`any`, `any`\>[]\>

#### Parameters

##### factory

(`emit`, `context`) => `C`

#### Returns

`AggregateBuilder`\<`S`, `Name`, `M` & \{ \[K in string \| number \| symbol\]: Parameters\<C\[K\]\>\[1\] \}, `E`, `EOverrides`, `Sel`\>

#### Example

```ts
.commands((emit, ctx) => ({
  dispatchShipment: (state, payload: { dest: string }) => {
    if (ctx.selectors.isReady(state)) return emit('dispatched', payload);
    throw new Error("Not ready");
  }
}))
```

***

### entities

> **entities**: \<`EN`, `T`\>(`entities?`, ...`entityPackages`) => `AggregateBuilder`\<`S`, `Name`, `M` & [`MergeEntities`](../-internal-/type-aliases/MergeEntities.md)\<`T`\>, `E`, `EOverrides`, `Sel`\>

Defined in: [createAggregateBuilder.ts:52](https://github.com/surikaterna/redemeine/blob/690161114c93099b83a558cc98f143d982e18c36/src/createAggregateBuilder.ts#L52)

Register nested entities into the aggregate's namespace. 
Entities keep their own private selectors and logic.
The naming engine will automatically map nested calls to targeted dot-notation commands (e.g. `order.order_lines.cancel.command`).

#### Type Parameters

##### EN

`EN` *extends* [`Record`](https://www.typescriptlang.org/docs/handbook/utility-types.html#recordkeys-type)\<`string`, `any`\> = \{ \}

##### T

`T` *extends* [`EntityPackage`](EntityPackage.md)\<`any`, `any`, `any`, `any`, `any`, `any`, `any`\>[] = \[\]

#### Parameters

##### entities?

`EN`

##### entityPackages

...`T`

#### Returns

`AggregateBuilder`\<`S`, `Name`, `M` & [`MergeEntities`](../-internal-/type-aliases/MergeEntities.md)\<`T`\>, `E`, `EOverrides`, `Sel`\>

#### Example

```ts
.entities({ orderLines: OrderLineEntity }) 
// Later used as: order.orderLines('line-1').cancel()
```

***

### events

> **events**: \<`NewE`\>(`events`) => `AggregateBuilder`\<`S`, `Name`, `M`, `E` & `NewE`, `EOverrides`, `Sel`\>

Defined in: [createAggregateBuilder.ts:90](https://github.com/surikaterna/redemeine/blob/690161114c93099b83a558cc98f143d982e18c36/src/createAggregateBuilder.ts#L90)

Register state-altering event handlers.
**Magic:** The `state` object inside these handlers is wrapped in Immer. You CAN mutate it directly!
The auto-namer maps camelCase keys to dot notation (e.g. `itemAdded` -> `aggregate.item_added.event`).

#### Type Parameters

##### NewE

`NewE` *extends* [`Record`](https://www.typescriptlang.org/docs/handbook/utility-types.html#recordkeys-type)\<`string`, (`state`, `event`) => `void`\>

#### Parameters

##### events

`NewE`

#### Returns

`AggregateBuilder`\<`S`, `Name`, `M`, `E` & `NewE`, `EOverrides`, `Sel`\>

#### Example

```ts
.events({
  itemAdded: (state, event) => { state.items.push(event.payload); }
})
```

***

### extends

> **extends**: \<`ParentM`, `ParentE`, `ParentEOverrides`, `ParentSel`\>(`parentBuilder`) => `AggregateBuilder`\<`S`, `Name`, `M` & `ParentM`, `E` & `ParentE`, `EOverrides` & `ParentEOverrides`, `Sel` & `ParentSel`\>

Defined in: [createAggregateBuilder.ts:39](https://github.com/surikaterna/redemeine/blob/690161114c93099b83a558cc98f143d982e18c36/src/createAggregateBuilder.ts#L39)

Inherit all business rules, selectors, and events from a parent aggregate builder.

#### Type Parameters

##### ParentM

`ParentM`

##### ParentE

`ParentE`

##### ParentEOverrides

`ParentEOverrides`

##### ParentSel

`ParentSel`

#### Parameters

##### parentBuilder

`AggregateBuilder`\<`S`, `any`, `ParentM`, `ParentE`, `ParentEOverrides`, `ParentSel`\>

#### Returns

`AggregateBuilder`\<`S`, `Name`, `M` & `ParentM`, `E` & `ParentE`, `EOverrides` & `ParentEOverrides`, `Sel` & `ParentSel`\>

#### Example

```ts
const Shipment = createAggregateBuilder('Shipment', initialShipment)
  .extends(OrderAggregate) // Inherits standard order rules while adding legs
```

***

### mixins

> **mixins**: \<`T`\>(...`mixins`) => `AggregateBuilder`\<`S`, `Name`, `M` & [`MergeMixins`](../-internal-/type-aliases/MergeMixins.md)\<`T`\>, `E`, `EOverrides`, `Sel`\>

Defined in: [createAggregateBuilder.ts:63](https://github.com/surikaterna/redemeine/blob/690161114c93099b83a558cc98f143d982e18c36/src/createAggregateBuilder.ts#L63)

Compose reusable domain logic chunks (Mixins) into this aggregate.

#### Type Parameters

##### T

`T` *extends* [`MixinPackage`](MixinPackage.md)\<`S`, `any`, `any`, `any`, `any`, `any`\>[]

#### Parameters

##### mixins

...`T`

#### Returns

`AggregateBuilder`\<`S`, `Name`, `M` & [`MergeMixins`](../-internal-/type-aliases/MergeMixins.md)\<`T`\>, `E`, `EOverrides`, `Sel`\>

#### Example

```ts
.mixins(TrackingMixin, AuditLoggerMixin)
```

***

### naming

> **naming**: (`strategy`) => `AggregateBuilder`\<`S`, `Name`, `M`, `E`, `EOverrides`, `Sel`\>

Defined in: [createAggregateBuilder.ts:98](https://github.com/surikaterna/redemeine/blob/690161114c93099b83a558cc98f143d982e18c36/src/createAggregateBuilder.ts#L98)

#### Parameters

##### strategy

[`Partial`](https://www.typescriptlang.org/docs/handbook/utility-types.html#partialtype)\<[`NamingStrategy`](NamingStrategy.md)\>

#### Returns

`AggregateBuilder`\<`S`, `Name`, `M`, `E`, `EOverrides`, `Sel`\>

***

### overrideCommandNames

> **overrideCommandNames**: (`overrides`) => `AggregateBuilder`\<`S`, `Name`, `M`, `E`, `EOverrides`, `Sel`\>

Defined in: [createAggregateBuilder.ts:117](https://github.com/surikaterna/redemeine/blob/690161114c93099b83a558cc98f143d982e18c36/src/createAggregateBuilder.ts#L117)

#### Parameters

##### overrides

[`Partial`](https://www.typescriptlang.org/docs/handbook/utility-types.html#partialtype)\<[`Record`](https://www.typescriptlang.org/docs/handbook/utility-types.html#recordkeys-type)\<keyof `M`, [`CommandType`](../type-aliases/CommandType.md)\>\>

#### Returns

`AggregateBuilder`\<`S`, `Name`, `M`, `E`, `EOverrides`, `Sel`\>

***

### overrideEventNames

> **overrideEventNames**: \<`NewEOverrides`\>(`overrides`) => `AggregateBuilder`\<`S`, `Name`, `M`, `E`, `EOverrides` & `NewEOverrides`, `Sel`\>

Defined in: [createAggregateBuilder.ts:94](https://github.com/surikaterna/redemeine/blob/690161114c93099b83a558cc98f143d982e18c36/src/createAggregateBuilder.ts#L94)

#### Type Parameters

##### NewEOverrides

`NewEOverrides` *extends* [`Partial`](https://www.typescriptlang.org/docs/handbook/utility-types.html#partialtype)\<[`Record`](https://www.typescriptlang.org/docs/handbook/utility-types.html#recordkeys-type)\<`string`, `` `${string}.event` ``\>\>

#### Parameters

##### overrides

`NewEOverrides`

#### Returns

`AggregateBuilder`\<`S`, `Name`, `M`, `E`, `EOverrides` & `NewEOverrides`, `Sel`\>

***

### selectors

> **selectors**: \<`NewSel`\>(`selectors`) => `AggregateBuilder`\<`S`, `Name`, `M`, `E`, `EOverrides`, `Sel` & `NewSel`\>

Defined in: [createAggregateBuilder.ts:76](https://github.com/surikaterna/redemeine/blob/690161114c93099b83a558cc98f143d982e18c36/src/createAggregateBuilder.ts#L76)

Define pure functions for reading and deriving state.
These will be injectable into your command handlers via the `context` parameter.

#### Type Parameters

##### NewSel

`NewSel` *extends* [`SelectorsMap`](../type-aliases/SelectorsMap.md)\<`S`\>

#### Parameters

##### selectors

`NewSel`

#### Returns

`AggregateBuilder`\<`S`, `Name`, `M`, `E`, `EOverrides`, `Sel` & `NewSel`\>

#### Example

```ts
.selectors({
  getTotalWeight: (state) => state.items.reduce((sum, item) => sum + item.weight, 0)
})
```
