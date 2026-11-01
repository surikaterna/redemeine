import { startupCodes, startupStages, startupHttpRoutes } from '../src/startupDiagnostics';
import { isRecord, assert } from './schema';
import { sha256 } from './receipts';
import { consumerHealthFacts } from '../src/infrastructure/consumerFacts';

const names = ['_id_', 'id_1', 'streamId_1_commitSequence_1', 'createDateTime_1', 'token_1'];
const fields = ['_id', 'id', 'streamId', 'commitSequence', 'createDateTime', 'token'];

export function sourceIndexFacts(value: unknown) {
  if (!isRecord(value)) return { shape: 'invalid' };
  const key = isRecord(value.key) ? Object.entries(value.key) : [];
  const safeKeys = key.length > 0 && key.length <= 6 && key.every(([field, direction]) => fields.includes(field)
    && typeof direction === 'number' && [1, -1].includes(direction));
  const name = typeof value.name === 'string' && value.name.length <= 512 ? value.name : undefined;
  const collation = value.collation;
  return { ...(name && names.includes(name) ? { name } : { nameHash: name ? sha256(name) : 'unavailable' }),
    ...(safeKeys ? { key: Object.fromEntries(key) } : { keyShape: 'unsupported' }),
    unique: value.unique === true, uniqueSpecified: value.unique !== undefined, sparse: value.sparse === true,
    hidden: value.hidden === true, ttl: value.expireAfterSeconds !== undefined, partial: value.partialFilterExpression !== undefined,
    collation: collation === undefined ? 'absent' : isRecord(collation) && collation.locale === 'simple' ? 'simple' : 'non_simple' };
}

export function startupFacts(value: unknown) {
  const body = isRecord(value) ? value : {};
  return { stage: startupStages.find((stage) => stage === body.startupStage) ?? 'none',
    code: startupCodes.find((code) => code === body.startupCode) ?? 'unknown_error',
    ...(startupHttpRoutes.find((route) => route === body.startupHttpRoute) ? {
      httpRoute: startupHttpRoutes.find((route) => route === body.startupHttpRoute) } : {}),
    ...(typeof body.startupHttpStatus === 'number' && Number.isInteger(body.startupHttpStatus) && body.startupHttpStatus >= 100
      && body.startupHttpStatus <= 599 ? { httpStatus: body.startupHttpStatus } : {}),
    ...(typeof body.startupHttpJson === 'boolean' ? { httpJson: body.startupHttpJson } : {}), ...consumerHealthFacts(body) };
}

export function assertPolicyRefusal(value: unknown): void {
  const facts = startupFacts(value);
  assert(facts.stage === 'binding' && facts.code === 'broker_policy_unproven', 'policy_refusal_cause_unproven');
}
