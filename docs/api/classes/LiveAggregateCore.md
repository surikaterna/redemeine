[**Redemeine API Reference**](../README.md)

***

[Redemeine API Reference](../README.md) / LiveAggregateCore

# Class: LiveAggregateCore\<S\>

Defined in: [createLiveAggregate.ts:29](https://github.com/surikaterna/redemeine/blob/690161114c93099b83a558cc98f143d982e18c36/src/createLiveAggregate.ts#L29)

## Type Parameters

### S

`S`

## Constructors

### Constructor

> **new LiveAggregateCore**\<`S`\>(`builder`, `id`, `state`, `contract?`, `strict?`): `LiveAggregateCore`\<`S`\>

Defined in: [createLiveAggregate.ts:33](https://github.com/surikaterna/redemeine/blob/690161114c93099b83a558cc98f143d982e18c36/src/createLiveAggregate.ts#L33)

#### Parameters

##### builder

[`BuiltAggregate`](../interfaces/BuiltAggregate.md)\<`S`, `any`\>

##### id

`string`

##### state

`S`

##### contract?

[`Contract`](Contract.md)

##### strict?

`boolean` = `false`

#### Returns

`LiveAggregateCore`\<`S`\>

## Properties

### builder

> **builder**: [`BuiltAggregate`](../interfaces/BuiltAggregate.md)\<`S`, `any`\>

Defined in: [createLiveAggregate.ts:34](https://github.com/surikaterna/redemeine/blob/690161114c93099b83a558cc98f143d982e18c36/src/createLiveAggregate.ts#L34)

***

### contract?

> `optional` **contract?**: [`Contract`](Contract.md)

Defined in: [createLiveAggregate.ts:37](https://github.com/surikaterna/redemeine/blob/690161114c93099b83a558cc98f143d982e18c36/src/createLiveAggregate.ts#L37)

***

### id

> **id**: `string`

Defined in: [createLiveAggregate.ts:35](https://github.com/surikaterna/redemeine/blob/690161114c93099b83a558cc98f143d982e18c36/src/createLiveAggregate.ts#L35)

***

### state

> **state**: `S`

Defined in: [createLiveAggregate.ts:36](https://github.com/surikaterna/redemeine/blob/690161114c93099b83a558cc98f143d982e18c36/src/createLiveAggregate.ts#L36)

***

### strict

> **strict**: `boolean` = `false`

Defined in: [createLiveAggregate.ts:38](https://github.com/surikaterna/redemeine/blob/690161114c93099b83a558cc98f143d982e18c36/src/createLiveAggregate.ts#L38)

***

### uncommitted

> **uncommitted**: [`Event`](../interfaces/Event.md)\<`any`, `` `${string}.event` ``\>[] = `[]`

Defined in: [createLiveAggregate.ts:30](https://github.com/surikaterna/redemeine/blob/690161114c93099b83a558cc98f143d982e18c36/src/createLiveAggregate.ts#L30)

***

### version

> **version**: `number` = `0`

Defined in: [createLiveAggregate.ts:31](https://github.com/surikaterna/redemeine/blob/690161114c93099b83a558cc98f143d982e18c36/src/createLiveAggregate.ts#L31)
