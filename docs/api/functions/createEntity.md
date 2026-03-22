[**Redemeine API Reference**](../README.md)

***

[Redemeine API Reference](../README.md) / createEntity

# Function: createEntity()

> **createEntity**\<`S`, `Name`\>(`name`): [`EntityEventsStage`](../interfaces/EntityEventsStage.md)\<`S`, `Name`\>

Defined in: [createEntity.ts:95](https://github.com/surikaterna/redemeine/blob/690161114c93099b83a558cc98f143d982e18c36/src/createEntity.ts#L95)

Bootstraps a new cohesive domain Entity. 
An entity encapsulates state, scoped selectors, events, and commands, to be injected into an AggregateBuilder.

## Type Parameters

### S

`S`

### Name

`Name` *extends* `string`

## Parameters

### name

`Name`

## Returns

[`EntityEventsStage`](../interfaces/EntityEventsStage.md)\<`S`, `Name`\>
