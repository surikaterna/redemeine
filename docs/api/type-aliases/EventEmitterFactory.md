[**Redemeine API Reference**](../README.md)

***

[Redemeine API Reference](../README.md) / EventEmitterFactory

# Type Alias: EventEmitterFactory\<AggregateName, E, EOverrides\>

> **EventEmitterFactory**\<`AggregateName`, `E`, `EOverrides`\> = \{ \[K in keyof E\]: E\[K\] extends (args: any\[\]) =\> any ? Parameters\<E\[K\]\>\["length"\] extends 0 \| 1 ? (args: \[ids: (string \| number)\[\]\]) =\> Event\<void, any\> : E\[K\] extends (state: any, event: Event\<infer P, any\>) =\> void ? \[P\] extends \[void\] \| \[undefined\] ? (args: \[ids: (...)\[\]\]) =\> Event\<void, any\> : (args: \[ids: (...)\[\], payload: P\]) =\> Event\<P, any\> : (args: \[ids: ((...) \| (...))\[\], payload: any\]) =\> Event\<any, any\> : never \} & [`Record`](https://www.typescriptlang.org/docs/handbook/utility-types.html#recordkeys-type)\<`string`, (...`args`) => [`Event`](../interfaces/Event.md)\<`any`, `any`\>\>

Defined in: [types.ts:87](https://github.com/surikaterna/redemeine/blob/690161114c93099b83a558cc98f143d982e18c36/src/types.ts#L87)

SMART EMITTER FACTORY
Checks the number of arguments in the event projector function.

## Type Parameters

### AggregateName

`AggregateName` *extends* `string`

### E

`E`

### EOverrides

`EOverrides`
