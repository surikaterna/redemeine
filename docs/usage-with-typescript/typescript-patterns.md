# Usage with TypeScript: Patterns and Best Practices

Redemeine was built from the ground up to provide a world-class, uncompromising TypeScript experience. We believe your type definitions should be the single source of truth for your domain model at compile time, with optional runtime enforcement through Contracts.

This guide covers the core patterns for typing your Aggregates, enforcing constraints, and exporting your compiled domain models for use across your application.

## Typing the State

Every aggregate begins with its state. Since Redemeine relies on Immer for safe mutations during the `.events()` phase, your state should consist of pure Plain Old JavaScript Objects (POJOs). Avoid classes, Maps, or Sets in your root state.

```ts
export interface UserProfile {
  id: string;
  name: string;
  email: string;
  isVerified: boolean;
  createdAt: number;
}

export interface AccountState {
  id: string;
  profile: UserProfile | null;
  status: 'pending' | 'active' | 'suspended';
}
```

When bootstrapping your aggregate, pass this state interface directly into the builder:

```ts
import { createAggregate } from 'redemeine';

const initialState: AccountState = {
  id: '',
  profile: null,
  status: 'pending'
};

// The generic <AccountState> locks the entire builder chain to this state shape
export const AccountAggregate = createAggregate<AccountState, 'Account'>('Account', initialState);
```

## Typing Commands and Events

In a traditional CQRS architecture, you often end up writing dual validations: a TypeScript interface for your compiler, and a separate Zod or Joi schema to ensure runtime safety.

> **The Redemeine Way:** Write your TypeScript interfaces once for compile-time safety. When you need runtime enforcement, pass a Contract into Mirage creation so command and event payloads are validated at runtime too.

### Defining Payloads

Often it is simpler to define your payloads using inline object types within the handlers themselves, but for reusability you can define literal interfaces:

```ts
export interface UpdateProfilePayload {
  name: string;
  email: string;
}

export interface ProfileUpdatedPayload {
  name: string;
  email: string;
  timestamp: number;
}
```

### The "Unified Pack" Pattern

While raw payload objects match standard Event Store serialization, sometimes you want your *UI and API callers* to pass in explicit arguments securely rather than bundling a large anonymous object. Enter the "Unified Pack" pattern:

```ts
  .commands((emit) => ({
    updateProfile: {
      // Create a specific, explicit TypeScript API signature using standard arguments
      pack: (name: string, email: string) => ({ name, email }),
      
      // The payload here is strictly inferred as `UpdateProfilePayload`
      handler: (state, payload: UpdateProfilePayload) => {
        if (state.status !== 'active') throw new Error('Cannot update');
        return emit.profileUpdated({ ...payload, timestamp: Date.now() });
      }
    }
  }))
```

Redemeine uses `Parameters<typeof pack>` underneath the hood, ensuring your Mirage instance flawlessly types `mirage.updateProfile("John", "john@example.com")` rather than `mirage.updateProfile({ name: "John", email: "john@example.com" })`.

### The "Type-Transparent" Magic

Here is where Redemeine shines. When you define your command handler, you type the `payload` argument. 

Because of Redemeine's Type-Transparent architecture, **you do not need manual type guards or parsing logic inside your handler.** Compile-time checks keep handlers strongly typed, and if you attach a Contract to Mirage, invalid runtime payloads are rejected before they touch your business logic.

```ts
  .commands((emit) => ({
    updateProfile: (state, payload: UpdateProfilePayload) => {
      // ❌ What you DON'T need to do:
      // if (!payload.name || typeof payload.name !== 'string') throw new Error(...)
      // const validData = ZodSchema.parse(payload)
      
      // ✅ What you DO:
      // Trust the type. Redemeine guarantees `payload` is strictly an `UpdateProfilePayload` here.
      
      if (state.status !== 'active') {
          throw new Error('Can only update active accounts');
      }

      return emit.profileUpdated({
        name: payload.name,
        email: payload.email,
        timestamp: Date.now()
      });
    }
  }))
```

## Exporting the Compiled Types

Once you have built your aggregate and exported the live constructor, you will often need to pass the running aggregate instance into your UI components (like React) or inject it into your API routes.

You can instantly infer the exact shape of your live aggregate (including all its dynamically generated command methods) using TypeScript's `typeof`.

```ts
// 1. Build the aggregate blueprint
export const AccountAggregate = createAggregate<AccountState, 'Account'>('Account', initialState)
  /* ... mixins, events, commands ... */
  .build();

// 2. We use createMirage to spawn live instances
import { createMirage } from 'redemeine';

export function getLiveAccount(id: string) {
    return createMirage(AccountAggregate, id);
}

// 3. ✨ Infer the fully hydrated live type!
export type LiveAccount = ReturnType<typeof getLiveAccount>;
```

Now, in your React components or API Handlers, you can strongly type your props:

```tsx
import type { LiveAccount } from '../domain/AccountAggregate';

interface ProfileViewProps {
    account: LiveAccount;
}

export const ProfileView = ({ account }: ProfileViewProps) => {
    return (
        <div>
            {/* Standard State Access */}
            <h1>{account.profile?.name}</h1>
            
            {/* Type-Safe Command Execution */}
            <button onClick={() => account.updateProfile({ name: 'New Name', email: 'new@email.com' })}>
                Update Profile
            </button>
        </div>
    )
}
```

By keeping your types strictly aligned to standard TypeScript behavior, Redemeine allows you to build deeply complex domain structures without fighting the compiler.
