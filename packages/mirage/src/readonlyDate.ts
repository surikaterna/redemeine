const getTime = Date.prototype.getTime;

export function dateTime(value: object): number | undefined {
  try {
    return getTime.call(value);
  } catch {
    return undefined;
  }
}

export function readonlyDate(time: number): Date {
  const data = Object.freeze(new Date(time));
  // Only native readers are bound; no custom method can recover the private Date.
  return new Proxy(data, {
    get(_target, property) {
      if (typeof property === 'string' && property.startsWith('set')) return undefined;
      if (!Object.hasOwn(Date.prototype, property)) return undefined;
      const member: unknown = Reflect.get(Date.prototype, property);
      return typeof member === 'function' && property !== 'constructor' ? member.bind(data) : member;
    },
    set() { throw new TypeError('Cannot mutate readonly Date'); },
    defineProperty() { throw new TypeError('Cannot mutate readonly Date'); },
    deleteProperty() { throw new TypeError('Cannot mutate readonly Date'); },
    setPrototypeOf() { throw new TypeError('Cannot mutate readonly Date'); }
  });
}
