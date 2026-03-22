[**Redemeine API Reference**](../README.md)

***

[Redemeine API Reference](../README.md) / EntityArray

# Variable: EntityArray

> `const` **EntityArray**: `object`

Defined in: [types.ts:35](https://github.com/surikaterna/redemeine/blob/690161114c93099b83a558cc98f143d982e18c36/src/types.ts#L35)

Utility toolkit for safely managing collections (arrays) of entities within Immer event handlers.
Ensures references are correctly mutated without mutating the entire array instance, preserving predictability.

## Type Declaration

### remove()

> **remove**\<`T`\>(`array`, `id`): `void`

Slices the entity matching the ID out of the collection entirely.

#### Type Parameters

##### T

`T` *extends* [`BaseEntity`](../interfaces/BaseEntity.md)

#### Parameters

##### array

`T`[]

##### id

`string` \| `number`

#### Returns

`void`

#### Example

```ts
EntityArray.remove(state.orderLines, 'line-1');
```

### update()

> **update**\<`T`\>(`array`, `id`, `patch`): `void`

Applies partial updates to an entity matching the given ID. Fails silently if missing.

#### Type Parameters

##### T

`T` *extends* [`BaseEntity`](../interfaces/BaseEntity.md)

#### Parameters

##### array

`T`[]

##### id

`string` \| `number`

##### patch

[`Partial`](https://www.typescriptlang.org/docs/handbook/utility-types.html#partialtype)\<`T`\>

#### Returns

`void`

#### Example

```ts
EntityArray.update(state.orderLines, 'line-1', { isCancelled: true });
```

### upsert()

> **upsert**\<`T`\>(`array`, `item`): `void`

Updates an entity by ID if it exists; otherwise, appends it strictly.

#### Type Parameters

##### T

`T` *extends* [`BaseEntity`](../interfaces/BaseEntity.md)

#### Parameters

##### array

`T`[]

##### item

`T`

#### Returns

`void`

#### Example

```ts
EntityArray.upsert(state.orderLines, { id: 'line-1', sku: 'A1' });
```
