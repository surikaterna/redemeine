type AggregateId = string;
interface Aggregate { }
interface Query { }
interface Cursor<T> { }

/**
 * Represents the repository layer or instantiated storage connection for an aggregate.
 * Handles the running state persistence across standard store operations.
 */
export interface Depot<TID extends AggregateId, T extends Aggregate> {
  findOne(id:TID): Promise<T>;
  find(query: Query): Cursor<T>;
  save(aggregate: T): Promise<T>;
}
