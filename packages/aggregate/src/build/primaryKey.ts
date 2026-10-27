import type { MountedEntityPackage, MountedStructureMetadata } from '../types/entityMount';

export function primaryKey(declaration: unknown): string | readonly string[] {
    if (declaration === undefined) return 'id';
    const fields: readonly unknown[] = typeof declaration === 'string' ? [declaration]
        : Array.isArray(declaration) ? declaration : [];
    if (!fields.length || !validFields(fields)
        || new Set(fields).size !== fields.length) {
        throw new Error('Invalid mounted command target: list primary key must contain nonempty unique field names');
    }
    return typeof declaration === 'string' ? declaration : fields;
}

function validFields(fields: readonly unknown[]): fields is readonly string[] {
    return Array.from(fields).every(field => typeof field === 'string' && field.length > 0);
}

// Revalidate at capture: callers may mutate PK arrays between registration and build.
export function validateListMounts(mounts: readonly (Pick<MountedStructureMetadata, 'kind' | 'pk'> & {
    component?: MountedEntityPackage['component'];
})[]): void {
    for (const mount of mounts) {
        if (mount.kind === 'list') primaryKey(mount.pk);
        if (!mount.component) continue;
        validateListMounts(mount.component.mountedEntities ?? []);
        validateListMounts(Object.values(mount.component.mounts ?? {}));
    }
}
