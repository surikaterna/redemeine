import type { EntityPackage } from './createEntity';

export const MirageContextSymbol = Symbol.for('MirageContext');

// SAFETY: `any` required for structural compatibility with arbitrary EntityPackage generic params
export type MirageRoleLike = EntityPackage<any, any, any, any, any, any, any>;

type DotPathKeys<T> = T extends Record<string, unknown>
  ? {
      [K in Extract<keyof T, string>]:
        T[K] extends Record<string, unknown>
          ? `${K}` | `${K}.${DotPathKeys<T[K]>}`
          : `${K}`
    }[Extract<keyof T, string>]
  : never;

export type MirageContextSingleBinding<TData, TRole extends MirageRoleLike, TMount extends string | undefined = string | undefined> = {
  [MirageContextSymbol]: {
    kind: 'single';
    data: TData;
    role: TRole;
    mount?: TMount;
  };
};

// SAFETY: `any` in data positions required for covariant readonly array inference
export type MirageContextPolymorphicBinding<
  TData extends readonly any[],
  TKey extends string,
  TRoleMap extends Record<string, MirageRoleLike>,
  TMount extends string | undefined = string | undefined
> = {
  [MirageContextSymbol]: {
    kind: 'polymorphic';
    data: TData;
    discriminatorKey: TKey;
    roleMap: TRoleMap;
    mount?: TMount;
  };
};

// SAFETY: `any` required for union discriminant — existential type erasure at binding site
export type MirageContextBinding =
  | MirageContextSingleBinding<any, MirageRoleLike>
  | MirageContextPolymorphicBinding<readonly any[], string, Record<string, MirageRoleLike>>;

export function bindContext<TData, const TRole extends MirageRoleLike, const TMount extends string | undefined = undefined>(
    data: TData,
    roleEntity: TRole,
    options?: { mount: TMount }
): MirageContextSingleBinding<TData, TRole, TMount>;

// SAFETY: `any` in const type param required for readonly tuple inference from arbitrary call sites
export function bindContext<
  const TData extends readonly any[],
  const TKey extends DotPathKeys<TData[number]>,
  const TRoleMap extends Record<string, MirageRoleLike>,
  const TMount extends string | undefined = undefined
>(
  data: TData,
  discriminatorKey: TKey,
  roleMap: TRoleMap,
  options?: { mount: TMount }
): MirageContextPolymorphicBinding<TData, TKey, TRoleMap, TMount>;

export function bindContext(
  data: unknown,
  roleOrKey: MirageRoleLike | string,
  maybeRoleMap?: Record<string, MirageRoleLike> | { mount: string },
  options?: { mount: string }
): MirageContextBinding {
  if (typeof roleOrKey === 'string') {
    return {
      [MirageContextSymbol]: {
        kind: 'polymorphic',
        data,
        discriminatorKey: roleOrKey,
        roleMap: maybeRoleMap || {},
        ...(options ? { mount: options.mount } : {})
      }
    } as MirageContextBinding;
  }

  return {
    [MirageContextSymbol]: {
      kind: 'single',
      data,
      role: roleOrKey,
      ...(maybeRoleMap && 'mount' in maybeRoleMap && typeof maybeRoleMap.mount === 'string' ? { mount: maybeRoleMap.mount } : {})
    }
  } as MirageContextBinding;
}

export const isMirageContextBinding = (value: unknown): value is MirageContextBinding => {
  return !!value && typeof value === 'object' && MirageContextSymbol in (value as Record<PropertyKey, unknown>);
};
