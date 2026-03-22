[**Redemeine API Reference**](../README.md)

***

[Redemeine API Reference](../README.md) / ResolveEventName

# Type Alias: ResolveEventName\<AggregateName, K, EOverrides\>

> **ResolveEventName**\<`AggregateName`, `K`, `EOverrides`\> = `K` *extends* keyof `EOverrides` ? `EOverrides`\[`K`\] *extends* [`EventType`](EventType.md) ? `EOverrides`\[`K`\] : `` `${AggregateName}.${Extract<K, string>}.event` `` : `` `${AggregateName}.${Extract<K, string>}.event` ``

Defined in: [types.ts:78](https://github.com/surikaterna/redemeine/blob/b5385f50ff070d36ff6e69e936f6843e8b07e4f9/src/types.ts#L78)

## Type Parameters

### AggregateName

`AggregateName` *extends* `string`

### K

`K`

### EOverrides

`EOverrides`
