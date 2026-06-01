/**
 * Shared guard utilities for proxy handlers.
 * Extracted to avoid duplicating the same typeof checks across every proxy file.
 */

/**
 * Returns true if prop is a string (valid property access for our proxy logic).
 */
export function isValidPropAccess(prop: string | symbol): prop is string {
    return typeof prop === 'string';
}
