import { guardCallback } from './descriptor';
import type { EnvelopeParser } from './envelopeTypes';

// Existential storage: a descriptor's callbacks are invoked with its own typed context by the future host.
type Callback = (...args: never[]) => object;
type Recipe = (...args: never[]) => undefined;
export interface EnvelopeSlot {
  readonly initialize: Callback;
  readonly parser: EnvelopeParser<object> | undefined;
  readonly recipes: readonly Recipe[];
}
export type EnvelopeSlots = Readonly<{ commandEnvelope?: EnvelopeSlot; eventEnvelope?: EnvelopeSlot }>;

export function declareEnvelope(existing: EnvelopeSlot | undefined, initialize: Callback, parser?: EnvelopeParser<object>): EnvelopeSlot {
  if (existing) throw new TypeError('Envelope initializer already declared');
  const parse = parser?.parse.bind(parser);
  return Object.freeze({
    initialize: guardCallback(initialize),
    parser: parse ? Object.freeze({ parse: guardCallback(parse) }) : undefined,
    recipes: Object.freeze([])
  });
}

export function appendRecipe(existing: EnvelopeSlot | undefined, recipe: Recipe): EnvelopeSlot {
  if (!existing) throw new TypeError('Declare an envelope initializer before recipes');
  return Object.freeze({ ...existing, recipes: Object.freeze([...existing.recipes, guardCallback(recipe)]) });
}

export function envelopeMethods<T>(slots: EnvelopeSlots, next: (slots: EnvelopeSlots) => T) {
  return {
    commandEnvelope: (initialize: Callback, parser?: EnvelopeParser<object>) =>
      next({ ...slots, commandEnvelope: declareEnvelope(slots.commandEnvelope, initialize, parser) }),
    eventEnvelope: (initialize: Callback, parser?: EnvelopeParser<object>) =>
      next({ ...slots, eventEnvelope: declareEnvelope(slots.eventEnvelope, initialize, parser) }),
    prepareCommand: (recipe: Recipe) => next({ ...slots, commandEnvelope: appendRecipe(slots.commandEnvelope, recipe) }),
    prepareEvent: (recipe: Recipe) => next({ ...slots, eventEnvelope: appendRecipe(slots.eventEnvelope, recipe) })
  };
}
