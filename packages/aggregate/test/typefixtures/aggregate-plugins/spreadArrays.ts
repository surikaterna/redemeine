import type { RedemeinePlugin } from '@redemeine/kernel';
import { createAggregate, createAggregatePlugin, createAggregatePluginFor } from '../../../src';

const host = createAggregate('arrays', { value: 0 });
const built = host.build();
const totals = createAggregatePlugin('totals').state(() => ({ count: 0 })).build();
const labels = createAggregatePlugin('labels').state(() => ({ text: '' })).build();
const plugins = [totals];
const builderState = host.plugins(...plugins).build().initialState;
const builtState = built.withPlugins(...plugins).initialState;
const optional: { count: number } | undefined = builderState.totals;
const optionalBuilt: { count: number } | undefined = builtState.totals;
if (builtState.totals) { const count: number = builtState.totals.count; void count; }
// @ts-expect-error arrays may be empty
builderState.totals.count;
// @ts-expect-error arrays may be empty on built aggregates too
builtState.totals.count;
const tupleCount: number = host.plugins(...([totals] as const)).build().initialState.totals.count;
const directCount: number = built.withPlugins(totals).initialState.totals.count;
const mixed = built.withPlugins(...([totals, labels] as (typeof totals | typeof labels)[])).initialState;
const heterogeneous = [totals, labels];
const mixedBuilder = host.plugins(...heterogeneous).build().initialState;
const optionalLabels: { text: string } | undefined = mixedBuilder.labels;
// @ts-expect-error heterogeneous arrays also require narrowing
mixedBuilder.totals.count;
if (mixed.totals) { const count: number = mixed.totals.count; void count; }
if (mixed.labels) { const text: string = mixed.labels.text; void text; }
// @ts-expect-error heterogeneous element state must not leak across IDs
mixed.totals?.text;
host.plugins(...([] as typeof totals[]));
built.withPlugins(...([] as []));
const legacy: RedemeinePlugin[] = [];
const legacyState = host.plugins(...legacy).build().initialState;
// @ts-expect-error legacy arrays add no state
legacyState.totals;
host.plugins({ key: 'inline', onBeforeAppend(ctx) {
  ctx.eventType.toUpperCase();
  // @ts-expect-error context must not be any
  ctx.nonexistent;
} });
built.withPlugins({ key: 'inline', onBeforeAppend(ctx) {
  ctx.eventType.toUpperCase();
  // @ts-expect-error context must not be any
  ctx.nonexistent;
} });
const collision = createAggregate('collision', { totals: 1 });
// @ts-expect-error a possible element collides
collision.plugins(...plugins);
// @ts-expect-error a possible element collides
collision.build().withPlugins(...plugins);
const unionHost = createAggregate('union', {} as { value: number } | { totals: number });
// @ts-expect-error collision in any host branch rejects the array
unionHost.plugins(...plugins);
// @ts-expect-error collision in any host branch rejects the array
unionHost.build().withPlugins(...plugins);
const widened = { ...totals, id: '' as string };
const widenedArray = [widened];
// @ts-expect-error dynamic widened-ID arrays are unsafe too
host.plugins(...widenedArray);
// @ts-expect-error mixing legacy descriptors cannot bypass widened-ID validation
built.withPlugins(...([...legacy, widened]));
// @ts-expect-error widened IDs must not mount Record<string, State>
host.plugins(...[widened]);
// @ts-expect-error widened IDs must not mount Record<string, State>
built.withPlugins(...[widened]);
const unionId = { ...totals, id: 'totals' as 'totals' | 'labels' };
const unionIdArray = [unionId];
// @ts-expect-error dynamic union IDs are unsafe
built.withPlugins(...unionIdArray);
// @ts-expect-error a single plugin needs one definite ID
host.plugins(...[unionId]);
const needsTotals = createAggregatePluginFor(built.withPlugins(totals), 'dependent').state(() => ({})).build();
const unordered = [totals, needsTotals];
// @ts-expect-error an unordered array cannot prove prerequisites from other elements
host.plugins(...unordered);
// @ts-expect-error built arrays cannot prove ordering either
built.withPlugins(...unordered);
const branchDependent = createAggregatePluginFor(createAggregate('required', { value: 0 }).build(), 'branchDependent')
  .state(() => ({})).build();
const branchArray = [branchDependent];
const missingBranch = createAggregate('missingBranch', {} as { value: number } | { other: number });
// @ts-expect-error every branch must satisfy the source-state prerequisite
missingBranch.plugins(...branchArray);
// @ts-expect-error every built branch must satisfy the prerequisite too
missingBranch.build().withPlugins(...branchArray);
built.withPlugins(totals).withPlugins(...[needsTotals]);
const tail = [labels];
const withTail = built.withPlugins(totals, ...tail).initialState;
const optionalHead: { count: number } | undefined = withTail.totals;
const optionalTail: { text: string } | undefined = withTail.labels;
const collisionTail = [totals];
// @ts-expect-error a dynamic tail can collide with the host state
built.withPlugins(totals).withPlugins(labels, ...collisionTail);
// @ts-expect-error a dynamic tail can collide with the host state
host.plugins(totals).plugins(labels, ...collisionTail);
void [optional, optionalBuilt, tupleCount, directCount, optionalHead, optionalTail, optionalLabels];
