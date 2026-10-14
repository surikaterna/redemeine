# @redemeine/cli

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
