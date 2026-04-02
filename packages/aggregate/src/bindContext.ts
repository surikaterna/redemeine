import type { EntityPackage } from './createEntity';

export const MirageContextSymbol = Symbol.for('MirageContext');

export type MirageRoleLike = EntityPackage<any, any, any, any, any, any, any>;

type DotPathKeys<T> = T extends Record<string, unknown>
  ? {
      [K in Extract<keyof T, string>]:
        T[K] extends Record<string, unknown>
          ? `${K}` | `${K}.${DotPathKeys<T[K]>}`
          : `${K}`
    }[Extract<keyof T, string>]
  : never;

export type MirageContextSingleBinding<TData, TRole extends MirageRoleLike> = {
  [MirageContextSymbol]: {
    kind: 'single';
    data: TData;
    role: TRole;
  };
};

export type MirageContextPolymorphicBinding<
  TData extends readonly any[],
  TKey extends string,
  TRoleMap extends Record<string, MirageRoleLike>
> = {
  [MirageContextSymbol]: {
    kind: 'polymorphic';
    data: TData;
    discriminatorKey: TKey;
    roleMap: TRoleMap;
  };
};

export type MirageContextBinding =
  | MirageContextSingleBinding<any, MirageRoleLike>
  | MirageContextPolymorphicBinding<readonly any[], string, Record<string, MirageRoleLike>>;

export function bindContext<TData, const TRole extends MirageRoleLike>(
  data: TData,
  roleEntity: TRole
): MirageContextSingleBinding<TData, TRole>;

export function bindContext<
  const TData extends readonly any[],
  const TKey extends DotPathKeys<TData[number]>,
  const TRoleMap extends Record<string, MirageRoleLike>
>(
  data: TData,
  discriminatorKey: TKey,
  roleMap: TRoleMap
): MirageContextPolymorphicBinding<TData, TKey, TRoleMap>;

export function bindContext(
  data: unknown,
  roleOrKey: MirageRoleLike | string,
  maybeRoleMap?: Record<string, MirageRoleLike>
): MirageContextBinding {
  if (typeof roleOrKey === 'string') {
    return {
      [MirageContextSymbol]: {
        kind: 'polymorphic',
        data,
        discriminatorKey: roleOrKey,
        roleMap: maybeRoleMap || {}
      }
    } as MirageContextBinding;
  }

  return {
    [MirageContextSymbol]: {
      kind: 'single',
      data,
      role: roleOrKey
    }
  } as MirageContextBinding;
}

export const isMirageContextBinding = (value: unknown): value is MirageContextBinding => {
  return !!value && typeof value === 'object' && MirageContextSymbol in (value as Record<PropertyKey, unknown>);
};
