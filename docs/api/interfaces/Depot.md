[**Redemeine API Reference**](../README.md)

***

[Redemeine API Reference](../README.md) / Depot

# Interface: Depot\<TID, T\>

Defined in: [Depot.ts:6](https://github.com/surikaterna/redemeine/blob/690161114c93099b83a558cc98f143d982e18c36/src/Depot.ts#L6)

## Type Parameters

### TID

`TID` *extends* [`AggregateId`](../-internal-/type-aliases/AggregateId.md)

### T

`T` *extends* [`Aggregate`](../-internal-/interfaces/Aggregate.md)

## Methods

### find()

> **find**(`query`): [`Cursor`](../-internal-/interfaces/Cursor.md)\<`T`\>

Defined in: [Depot.ts:8](https://github.com/surikaterna/redemeine/blob/690161114c93099b83a558cc98f143d982e18c36/src/Depot.ts#L8)

#### Parameters

##### query

[`Query`](../-internal-/interfaces/Query.md)

#### Returns

[`Cursor`](../-internal-/interfaces/Cursor.md)\<`T`\>

***

### findOne()

> **findOne**(`id`): [`Promise`](https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`T`\>

Defined in: [Depot.ts:7](https://github.com/surikaterna/redemeine/blob/690161114c93099b83a558cc98f143d982e18c36/src/Depot.ts#L7)

#### Parameters

##### id

`TID`

#### Returns

[`Promise`](https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`T`\>

***

### save()

> **save**(`aggregate`): [`Promise`](https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`T`\>

Defined in: [Depot.ts:9](https://github.com/surikaterna/redemeine/blob/690161114c93099b83a558cc98f143d982e18c36/src/Depot.ts#L9)

#### Parameters

##### aggregate

`T`

#### Returns

[`Promise`](https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`T`\>
