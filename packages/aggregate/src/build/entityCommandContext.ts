import { createCommandContextProxy } from '../proxies/createCommandContextProxy';

export function entitySelectorContext(selectors: object, root: object, mount: string): Record<string, unknown> {
    return new Proxy({ ...selectors, root }, {
        get(target, property) {
            if (property in selectors && property in root && property !== 'root') {
                console.warn(`[Selector Shadowing]: entity "${mount}" and root both define "${String(property)}". Use "selectors.root.${String(property)}" to access the root selector.`);
            }
            return property in target ? Reflect.get(target, property) : Reflect.get(root, property);
        }
    });
}

export function createRoleCommandResolver(emit: unknown, rootSelectors: object, mount: string): (role: object) => readonly string[] {
    // Factory results can depend on the aggregate/mount context, not just role identity.
    const cache = new WeakMap<object, readonly string[]>();
    return role => {
        const cached = cache.get(role);
        if (cached) return cached;
        if (!('commandFactory' in role) || typeof role.commandFactory !== 'function') throw new Error('Invalid selector role');
        const selectors = 'selectors' in role && role.selectors && typeof role.selectors === 'object' ? role.selectors : {};
        const commands: unknown = Reflect.apply(role.commandFactory, role, [emit, {
            selectors: entitySelectorContext(selectors, rootSelectors, mount),
            commands: createCommandContextProxy<Record<string, unknown>>()
        }]);
        if (!commands || typeof commands !== 'object') throw new Error('Invalid selector role command map');
        const names = Object.freeze(Object.keys(commands));
        cache.set(role, names);
        return names;
    };
}
