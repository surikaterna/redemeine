import { AggregateBuilder } from 'redemeine';

/** 1. Pure TypeScript Contracts */
export interface RegisterUser {
  id: string;
  username: string;
}

export interface UserState {
  id?: string;
  username?: string;
  status: 'guest' | 'registered';
}

/** 2. Clean Aggregate Composition */
export const UserAggregate = new AggregateBuilder<UserState>()
  .events({
    /** State Projection: Direct mutation via Immer */
    userRegistered: (state, event: RegisterUser) => {
      state.id = event.id;
      state.username = event.username;
      state.status = 'registered';
    }
  })
  .commands({
    /** Business Logic: Validation is handled by Redemeine internally */
    register: (state, cmd: RegisterUser) => {
      if (state.status === 'registered') {
        throw new Error("User is already registered");
      }
      
      return { 
        type: 'userRegistered', 
        data: cmd 
      };
    }
  })
  .build();