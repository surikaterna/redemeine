const CAPACITY_CODES = new Set([10334, 13548, 17419]);
const CAPACITY_MESSAGES = [
  'bsonobj size',
  'bson object too large',
  'object to insert too large',
  'document is larger than',
  'exceeds maximum allowed bson size',
  'object to serialize exceeds bson size'
];

export const isMongoPhysicalCapacityError = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;
  const mongoError = error as Error & { code?: number | string; codeName?: string };
  if (typeof mongoError.code === 'number' && CAPACITY_CODES.has(mongoError.code)) return true;
  if (mongoError.codeName?.toLowerCase() === 'bsonobjecttoolarge') return true;
  const message = mongoError.message.toLowerCase();
  const nodeCode = typeof mongoError.code === 'string' ? mongoError.code : '';
  const fromBsonSerializer = mongoError.stack?.includes('/bson/') === true || mongoError.stack?.includes('bson/src/') === true;
  if (fromBsonSerializer && ['ERR_OUT_OF_RANGE', 'ERR_BUFFER_OUT_OF_BOUNDS'].includes(nodeCode)) return true;
  return CAPACITY_MESSAGES.some((candidate) => message.includes(candidate));
};
