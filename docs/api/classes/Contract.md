[**Redemeine API Reference**](../README.md)

***

[Redemeine API Reference](../README.md) / Contract

# Class: Contract

Defined in: [Contract.ts:19](https://github.com/surikaterna/redemeine/blob/b5385f50ff070d36ff6e69e936f6843e8b07e4f9/src/Contract.ts#L19)

## Constructors

### Constructor

> **new Contract**(): `Contract`

Defined in: [Contract.ts:24](https://github.com/surikaterna/redemeine/blob/b5385f50ff070d36ff6e69e936f6843e8b07e4f9/src/Contract.ts#L24)

#### Returns

`Contract`

## Properties

### commands

> **commands**: [`Map`](https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/Map)\<`string`, `ZodType`\<`unknown`, `unknown`, `$ZodTypeInternals`\<`unknown`, `unknown`\>\>\>

Defined in: [Contract.ts:20](https://github.com/surikaterna/redemeine/blob/b5385f50ff070d36ff6e69e936f6843e8b07e4f9/src/Contract.ts#L20)

***

### events

> **events**: [`Map`](https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/Map)\<`string`, `ZodType`\<`unknown`, `unknown`, `$ZodTypeInternals`\<`unknown`, `unknown`\>\>\>

Defined in: [Contract.ts:21](https://github.com/surikaterna/redemeine/blob/b5385f50ff070d36ff6e69e936f6843e8b07e4f9/src/Contract.ts#L21)

***

### stateSchema?

> `optional` **stateSchema?**: `ZodType`

Defined in: [Contract.ts:22](https://github.com/surikaterna/redemeine/blob/b5385f50ff070d36ff6e69e936f6843e8b07e4f9/src/Contract.ts#L22)

## Methods

### addCommand()

> **addCommand**(`type`, `schema`): `this`

Defined in: [Contract.ts:29](https://github.com/surikaterna/redemeine/blob/b5385f50ff070d36ff6e69e936f6843e8b07e4f9/src/Contract.ts#L29)

#### Parameters

##### type

`string`

##### schema

`ZodType`

#### Returns

`this`

***

### addEvent()

> **addEvent**(`type`, `schema`): `this`

Defined in: [Contract.ts:34](https://github.com/surikaterna/redemeine/blob/b5385f50ff070d36ff6e69e936f6843e8b07e4f9/src/Contract.ts#L34)

#### Parameters

##### type

`string`

##### schema

`ZodType`

#### Returns

`this`

***

### getCommand()

> **getCommand**(`type`): `ZodType`\<`unknown`, `unknown`, `$ZodTypeInternals`\<`unknown`, `unknown`\>\>

Defined in: [Contract.ts:44](https://github.com/surikaterna/redemeine/blob/b5385f50ff070d36ff6e69e936f6843e8b07e4f9/src/Contract.ts#L44)

#### Parameters

##### type

`string`

#### Returns

`ZodType`\<`unknown`, `unknown`, `$ZodTypeInternals`\<`unknown`, `unknown`\>\>

***

### getEvent()

> **getEvent**(`type`): `ZodType`\<`unknown`, `unknown`, `$ZodTypeInternals`\<`unknown`, `unknown`\>\>

Defined in: [Contract.ts:48](https://github.com/surikaterna/redemeine/blob/b5385f50ff070d36ff6e69e936f6843e8b07e4f9/src/Contract.ts#L48)

#### Parameters

##### type

`string`

#### Returns

`ZodType`\<`unknown`, `unknown`, `$ZodTypeInternals`\<`unknown`, `unknown`\>\>

***

### setStateSchema()

> **setStateSchema**(`schema`): `this`

Defined in: [Contract.ts:39](https://github.com/surikaterna/redemeine/blob/b5385f50ff070d36ff6e69e936f6843e8b07e4f9/src/Contract.ts#L39)

#### Parameters

##### schema

`ZodType`

#### Returns

`this`

***

### validateCommand()

> **validateCommand**(`type`, `data`): `any`

Defined in: [Contract.ts:52](https://github.com/surikaterna/redemeine/blob/b5385f50ff070d36ff6e69e936f6843e8b07e4f9/src/Contract.ts#L52)

#### Parameters

##### type

`string`

##### data

`unknown`

#### Returns

`any`

***

### validateEvent()

> **validateEvent**(`type`, `data`): `any`

Defined in: [Contract.ts:66](https://github.com/surikaterna/redemeine/blob/b5385f50ff070d36ff6e69e936f6843e8b07e4f9/src/Contract.ts#L66)

#### Parameters

##### type

`string`

##### data

`unknown`

#### Returns

`any`

***

### validateState()

> **validateState**(`data`): `any`

Defined in: [Contract.ts:80](https://github.com/surikaterna/redemeine/blob/b5385f50ff070d36ff6e69e936f6843e8b07e4f9/src/Contract.ts#L80)

#### Parameters

##### data

`unknown`

#### Returns

`any`

***

### fromZodExports()

> `static` **fromZodExports**(`exportsObj`): `Contract`

Defined in: [Contract.ts:91](https://github.com/surikaterna/redemeine/blob/b5385f50ff070d36ff6e69e936f6843e8b07e4f9/src/Contract.ts#L91)

#### Parameters

##### exportsObj

`any`

#### Returns

`Contract`
