[**Redemeine API Reference**](../README.md)

***

[Redemeine API Reference](../README.md) / LiveAggregateDepot

# Class: LiveAggregateDepot\<S, M\>

Defined in: [createLiveAggregate.ts:182](https://github.com/surikaterna/redemeine/blob/b5385f50ff070d36ff6e69e936f6843e8b07e4f9/src/createLiveAggregate.ts#L182)

## Type Parameters

### S

`S`

### M

`M` *extends* [`Record`](https://www.typescriptlang.org/docs/handbook/utility-types.html#recordkeys-type)\<`string`, `any`\>

## Constructors

### Constructor

> **new LiveAggregateDepot**\<`S`, `M`\>(`builder`, `depot`, `options?`): `LiveAggregateDepot`\<`S`, `M`\>

Defined in: [createLiveAggregate.ts:183](https://github.com/surikaterna/redemeine/blob/b5385f50ff070d36ff6e69e936f6843e8b07e4f9/src/createLiveAggregate.ts#L183)

#### Parameters

##### builder

[`BuiltAggregate`](../interfaces/BuiltAggregate.md)\<`S`, `M`\>

##### depot

[`Depot`](../interfaces/Depot.md)\<`string`, `S`\>

##### options?

[`LiveAggregateOptions`](../interfaces/LiveAggregateOptions.md)

#### Returns

`LiveAggregateDepot`\<`S`, `M`\>

## Methods

### findById()

> **findById**(`id`): [`Promise`](https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<[`LiveCommandMap`](../type-aliases/LiveCommandMap.md)\<`S`, `M`\> & [`Readonly`](https://www.typescriptlang.org/docs/handbook/utility-types.html#readonlytype)\<`S`\> & [`Record`](https://www.typescriptlang.org/docs/handbook/utility-types.html#recordkeys-type)\<`string`, `any`\>\>

Defined in: [createLiveAggregate.ts:189](https://github.com/surikaterna/redemeine/blob/b5385f50ff070d36ff6e69e936f6843e8b07e4f9/src/createLiveAggregate.ts#L189)

#### Parameters

##### id

`string`

#### Returns

[`Promise`](https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<[`LiveCommandMap`](../type-aliases/LiveCommandMap.md)\<`S`, `M`\> & [`Readonly`](https://www.typescriptlang.org/docs/handbook/utility-types.html#readonlytype)\<`S`\> & [`Record`](https://www.typescriptlang.org/docs/handbook/utility-types.html#recordkeys-type)\<`string`, `any`\>\>

***

### new()

> **new**(`id?`): [`LiveCommandMap`](../type-aliases/LiveCommandMap.md)\<`S`, `M`\> & [`Readonly`](https://www.typescriptlang.org/docs/handbook/utility-types.html#readonlytype)\<`S`\> & [`Record`](https://www.typescriptlang.org/docs/handbook/utility-types.html#recordkeys-type)\<`string`, `any`\>

Defined in: [createLiveAggregate.ts:197](https://github.com/surikaterna/redemeine/blob/b5385f50ff070d36ff6e69e936f6843e8b07e4f9/src/createLiveAggregate.ts#L197)

#### Parameters

##### id?

`string` = `...`

#### Returns

[`LiveCommandMap`](../type-aliases/LiveCommandMap.md)\<`S`, `M`\> & [`Readonly`](https://www.typescriptlang.org/docs/handbook/utility-types.html#readonlytype)\<`S`\> & [`Record`](https://www.typescriptlang.org/docs/handbook/utility-types.html#recordkeys-type)\<`string`, `any`\>

***

### save()

> **save**(`liveAggregate`): [`Promise`](https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`S`\>

Defined in: [createLiveAggregate.ts:201](https://github.com/surikaterna/redemeine/blob/b5385f50ff070d36ff6e69e936f6843e8b07e4f9/src/createLiveAggregate.ts#L201)

#### Parameters

##### liveAggregate

[`LiveCommandMap`](../type-aliases/LiveCommandMap.md)\<`S`, `M`\> & [`Readonly`](https://www.typescriptlang.org/docs/handbook/utility-types.html#readonlytype)\<`S`\> & [`Record`](https://www.typescriptlang.org/docs/handbook/utility-types.html#recordkeys-type)\<`string`, `any`\>

#### Returns

[`Promise`](https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`S`\>
