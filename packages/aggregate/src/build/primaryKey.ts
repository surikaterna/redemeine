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
    name?: string;
    entity?: object | undefined;
    component?: MountedEntityPackage['component'];
})[]): void {
    const definitions = new Map<string, object>();
    for (const mount of mounts) {
        const entity = mount.component ?? mount.entity;
        const previous = mount.name === undefined ? undefined : definitions.get(mount.name);
        if (previous && entity && previous !== entity) {
            const names = [previous, entity].map(definition => 'name' in definition ? String(definition.name) : '<anonymous>');
            throw new Error(`Conflicting entity definitions at mount "${mount.name}": "${names[0]}" and "${names[1]}"`);
        }
        if (mount.name !== undefined && entity) definitions.set(mount.name, entity);
        if (mount.kind === 'list') primaryKey(mount.pk);
        if (!mount.component) continue;
        validateListMounts(mount.component.mountedEntities ?? []);
        validateListMounts(Object.values(mount.component.mounts ?? {}));
    }
}
