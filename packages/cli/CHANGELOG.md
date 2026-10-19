# @redemeine/cli

## 1.0.0-pre.3

### Major Changes

- [#142](https://github.com/surikaterna/redemeine/pull/142) [`87809b6`](https://github.com/surikaterna/redemeine/commit/87809b69f3e5622f8505fa7e89907cdce823aa3c) Thanks [@spralle](https://github.com/spralle)! - Preserve supported TypeScript intersections in generated Zod schemas instead of
  falling back to z.any(). Resolve structural object properties together, preserving
  overlapping constraints and requiredness; use intersections for supported array,
  record and supplied-schema combinations. Unsupported intersection shapes now
  report an error before output files are written.

  Generate consistently formatted source with safe readable keys, deterministic
  sections and schema ordering, source-relative provenance, concise source JSDoc,
  and source comments. Existing map/export names and void payload semantics remain.

  Default schema compilation to zod-first, configured per owning package through
  redemeine.schemas.mode and redemeine.schemas.maxDepth (default 60, range 1–256).
  Types-only projects must explicitly select types-first. Both modes prefer existing
  importable Zod schemas, including recoverable primitive aliases, instead of
  regenerating them. Missing schemas in zod-first and private/unresolvable exports
  fail before writing output. Existing runtime builder signatures are unchanged.

  Support structural readonly arrays/tuples and preserve unknown as z.unknown().
  Reject unresolved types, unsupported shapes, recursion and depth exhaustion rather
  than silently widening to z.any(). Require strictNullChecks for structural fidelity.
  Raw compiler-only JSON is types-first only and refuses recognized authored schema
  references; use linked Zod/registry modules and explicit z.toJSONSchema evaluation
  to preserve those schemas. No application source is executed during extraction,
  and no handwritten application validator is replaced automatically.

## 0.2.0-pre.2

### Patch Changes

- [#123](https://github.com/surikaterna/redemeine/pull/123) [`dce55cd`](https://github.com/surikaterna/redemeine/commit/dce55cd815ad7e1da73858d9fa80b9a0f3f43509) Thanks [@spralle](https://github.com/spralle)! - Keep distinct compiler payload types and generated/imported schema bindings independent, and reject strict-mode restricted scaffold names before writing files.

  Do not memoize depth-truncated alias conversions or their enclosing aliases as
  complete schemas. Later direct payload conversions retain their validation
  regardless of traversal order; the existing bounded-depth fallback remains.

## 0.2.0-pre.1

### Minor Changes

- [#134](https://github.com/surikaterna/redemeine/pull/134) [`f8063f7`](https://github.com/surikaterna/redemeine/commit/f8063f7c91f93ce442697fe61ad64c46d020eebc) Thanks [@spralle](https://github.com/spralle)! - Add compiler-only JSON Schema output to aggregate and projection extract-schemas,
  with draft-7 and draft-2020-12 targets. Keep Zod as the unchanged default. JSON
  conversion resolves structural data intersections without executing application
  or schema modules, diagnoses unsupported/unresolved types before output writes,
  and documents explicit any/unknown and void metadata semantics. CLI publication
  is approved but not yet completed; separately supplied developer artifacts remain
  supported.

### Patch Changes

- [#134](https://github.com/surikaterna/redemeine/pull/134) [`7a318db`](https://github.com/surikaterna/redemeine/commit/7a318db1ea44ba1a3553dc2dba1564560ab313f6) Thanks [@spralle](https://github.com/spralle)! - Declare the CLI's owning repository and package directory so approved publication
  can be qualified against the correct source identity. This metadata-only patch
  combines with the pending CLI feature changeset. Its historical publication hold
  has now been removed following user approval; this does not publish the package
  or bypass reviewed main-source and npm-owner gates.
- Updated dependencies [[`7cf5217`](https://github.com/surikaterna/redemeine/commit/7cf5217b3be22dd81c92892c24bc8b9e017e72a3)]:
  - @redemeine/kernel@0.2.0-pre.2

## 0.2.0-pre.0

### Minor Changes

- [#122](https://github.com/surikaterna/redemeine/pull/122) [`7753647`](https://github.com/surikaterna/redemeine/commit/77536474b3f0c58d3497796778d3040733b276ed) Thanks [@spralle](https://github.com/spralle)! - Introduce a standalone CLI package for domain scaffolding and schema extraction.

### Patch Changes

- [#127](https://github.com/surikaterna/redemeine/pull/127) [`0fac88c`](https://github.com/surikaterna/redemeine/commit/0fac88c5bcaeae48c164556f3a0f70f375233f77) Thanks [@spralle](https://github.com/spralle)! - Resolve the kernel from the workspace during versioning and pack its exact release version. CLI publication remains held pending separate first-release approval.

- Updated dependencies [[`3602d22`](https://github.com/surikaterna/redemeine/commit/3602d22a4961eba06af4712febd14f4248eb36ea)]:
  - @redemeine/kernel@0.2.0-pre.1
