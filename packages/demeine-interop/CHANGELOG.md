# @redemeine/demeine-interop

## 0.1.0-pre.1

### Minor Changes

- [#134](https://github.com/surikaterna/redemeine/pull/134) [`7cf5217`](https://github.com/surikaterna/redemeine/commit/7cf5217b3be22dd81c92892c24bc8b9e017e72a3) Thanks [@spralle](https://github.com/spralle)! - Move the legacy bridge out of Mirage into the new demeine-interop package. The
  replacement API requires the application's Aggregate base and returns a constructor,
  preserving its sink, dispatchers, queue, replay and reserved deletion lifecycle.
  Mirage no longer exports the old callable bridge. Kernel, aggregate and interop now
  provide independent CommonJS and ESM entry points with matching declarations.

### Patch Changes

- [#134](https://github.com/surikaterna/redemeine/pull/134) [`f7d1476`](https://github.com/surikaterna/redemeine/commit/f7d14766a5885772bda05536eeae674194a3a219) Thanks [@spralle](https://github.com/spralle)! - Let generated no-payload shortcuts reach the legacy queue by normalizing missing
  or undefined creator payloads to a fresh empty object on a copied envelope.
  Preserve object pack identity and reject explicit null/scalar payloads as before.
  The sink and builder contract see the same object; void-only contracts are not
  bypassed and require an object-compatible contract at this legacy boundary.
- Updated dependencies [[`7cf5217`](https://github.com/surikaterna/redemeine/commit/7cf5217b3be22dd81c92892c24bc8b9e017e72a3)]:
  - @redemeine/kernel@0.2.0-pre.2
