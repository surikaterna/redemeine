const MAX_BSON_BYTES = 16 * 1024 * 1024;
const DOCUMENT_OVERHEAD_BYTES = 5; // length word and trailing NUL

export class MongoReceiptCapacityError extends Error {
  constructor() {
    super('MongoDB projection_changes receipt exceeds the 16 MiB physical BSON document limit.');
  }
}

export class MongoReceiptEncodingError extends Error {}

function elementHeader(key: string | number): number {
  const name = String(key);
  if (name.includes('\0')) throw new MongoReceiptEncodingError('Invalid key in MongoDB projection_changes BSON.');
  return 2 + Buffer.byteLength(name); // element type and NUL-terminated key
}

function scalarBytes(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'string') return 5 + Buffer.byteLength(value);
  if (typeof value === 'boolean') return 1;
  if (typeof value === 'number') {
    // Match the MongoDB driver's serializer, which writes negative zero as a double.
    return !Object.is(value, -0) && Number.isInteger(value) && value >= -0x80000000 && value <= 0x7fffffff ? 4 : 8;
  }
  throw new MongoReceiptEncodingError('MongoDB projection_changes receipt requires portable BSON values.');
}

/** Meter the actual BSON representation as it is built, without serializing a second copy. */
export class ReceiptBudget {
  private bytes = DOCUMENT_OVERHEAD_BYTES;

  constructor(envelope: object) {
    for (const [key, value] of Object.entries(envelope)) this.add(key, value);
  }

  open(key: string | number): void {
    this.spend(elementHeader(key) + DOCUMENT_OVERHEAD_BYTES);
  }

  add(key: string | number, value: unknown, depth = 0): void {
    if (depth > 200) throw new MongoReceiptEncodingError('Invalid depth for MongoDB projection_changes BSON.');
    if (value === null || typeof value !== 'object') {
      this.spend(elementHeader(key) + scalarBytes(value));
    } else if (Array.isArray(value)) {
      this.open(key);
      for (let index = 0; index < value.length; index += 1) this.add(index, value[index], depth + 1);
    } else {
      this.addObject(key, value, depth);
    }
  }

  private addObject(key: string | number, value: object, depth: number): void {
    if (Object.prototype.toString.call(value) !== '[object Object]' || '_bsontype' in value && value._bsontype != null
      || 'toBSON' in value && typeof value.toBSON === 'function') {
      throw new MongoReceiptEncodingError('MongoDB projection_changes receipt requires portable BSON values.');
    }
    this.open(key);
    const fields = value as Record<string, unknown>;
    for (const field in fields) {
      if (Object.hasOwn(fields, field)) this.add(field, fields[field], depth + 1);
    }
  }

  private spend(bytes: number): void {
    this.bytes += bytes;
    if (this.bytes > MAX_BSON_BYTES) throw new MongoReceiptCapacityError();
  }
}
