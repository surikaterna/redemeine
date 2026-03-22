type AggregateId = string;
interface Aggregate { }
interface Query { }
interface Cursor<T> { }

export interface Depot<TID extends AggregateId, T extends Aggregate> {
  findOne(id:TID): Promise<T>;
  find(query: Query): Cursor<T>;
  save(aggregate: T): Promise<T>;
}
