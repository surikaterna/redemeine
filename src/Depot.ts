interface Aggregate {}

export interface Depot<T extends Aggregate> {
  findOne(): T;
  find(query): T;
  save(aggregate: T): Promise<T>;
}
