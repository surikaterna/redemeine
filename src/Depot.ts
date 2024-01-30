interface Aggregate { }
interface Query { }
interface Cursor<T> { }

export interface Depot<T extends Aggregate> {
  findOne(): T;
  find(query: Query): Cursor<T>;
  save(aggregate: T): Promise<T>;
}
