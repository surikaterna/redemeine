[**Redemeine API Reference**](../README.md)

***

[Redemeine API Reference](../README.md) / createLegacyAggregateBridge

# Function: createLegacyAggregateBridge()

> **createLegacyAggregateBridge**\<`S`, `M`\>(`liveAggregate`): `object`

Defined in: [createLiveAggregate.ts:167](https://github.com/surikaterna/redemeine/blob/b5385f50ff070d36ff6e69e936f6843e8b07e4f9/src/createLiveAggregate.ts#L167)

## Type Parameters

### S

`S`

### M

`M`

## Parameters

### liveAggregate

[`LiveCommandMap`](../type-aliases/LiveCommandMap.md)\<`S`, `M`\> & [`Readonly`](https://www.typescriptlang.org/docs/handbook/utility-types.html#readonlytype)\<`S`\> & [`Record`](https://www.typescriptlang.org/docs/handbook/utility-types.html#recordkeys-type)\<`string`, `any`\>

## Returns

`object`

### clearUncommittedEvents

> **clearUncommittedEvents**: () => `void`

#### Returns

`void`

### getUncommittedEvents

> **getUncommittedEvents**: () => [`Event`](../interfaces/Event.md)\<`any`, `` `${string}.event` ``\>[]

#### Returns

[`Event`](../interfaces/Event.md)\<`any`, `` `${string}.event` ``\>[]

### getUncommittedEventsAsync

> **getUncommittedEventsAsync**: () => [`Promise`](https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<[`Event`](../interfaces/Event.md)\<`any`, `` `${string}.event` ``\>[]\>

#### Returns

[`Promise`](https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<[`Event`](../interfaces/Event.md)\<`any`, `` `${string}.event` ``\>[]\>

### getVersion

> **getVersion**: () => `number`

#### Returns

`number`

### \_state

#### Get Signature

> **get** **\_state**(): `S`

##### Returns

`S`

### id

#### Get Signature

> **get** **id**(): `string`

##### Returns

`string`
