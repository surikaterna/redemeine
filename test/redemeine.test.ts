import { describe, expect, test } from '@jest/globals';
import { Depot } from '../src/Depot';

describe('Depot', () => {
  test('return object', () => {
    class DD implements Depot<{}> {
      findOne(): {} {
        return {};
      }
      find(query: any): {} {
        throw new Error('Method not implemented.');
      }
      save(aggregate: {}): Promise<{}> {
        throw new Error('Method not implemented.');
      }
    }
    const dd = new DD();
    expect(dd.findOne()).toBeTruthy();
  });
});
