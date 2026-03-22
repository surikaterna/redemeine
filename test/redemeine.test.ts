import { describe, expect, test } from '@jest/globals';
import { Depot } from '../src/Depot';

describe('Depot', () => {
  test('return object', () => {
    class DD implements Depot<string, {}> {
      findOne(id: string): Promise<{}> {
        return Promise.resolve({});
      }
      find(query: any): any {
        throw new Error('Method not implemented.');
      }
      save(aggregate: {}): Promise<{}> {
        return Promise.resolve({});
      }
    }
    const dd = new DD();
    expect(dd.findOne('1')).resolves.toBeTruthy();
  });
});
