# @redemeine/saga

## 0.1.1-pre.7

### Patch Changes

- Updated dependencies [[`db9bdf9`](https://github.com/surikaterna/redemeine/commit/db9bdf94a4358a45835dd85c7fbe3ff8ed410892), [`adca961`](https://github.com/surikaterna/redemeine/commit/adca96123e1a2fb9ff4740286c1bbdc9db5d9996), [`d5e5ec9`](https://github.com/surikaterna/redemeine/commit/d5e5ec9212759ea5e9a86fc196d06596334c05c6), [`e99c57a`](https://github.com/surikaterna/redemeine/commit/e99c57a421af3d9e9c7c42c4d20ea63ac44db962), [`e99c57a`](https://github.com/surikaterna/redemeine/commit/e99c57a421af3d9e9c7c42c4d20ea63ac44db962), [`d5e5ec9`](https://github.com/surikaterna/redemeine/commit/d5e5ec9212759ea5e9a86fc196d06596334c05c6), [`eb0d2e4`](https://github.com/surikaterna/redemeine/commit/eb0d2e419bbeadd3018b5a6f8e2375a68f4cddef)]:
  - @redemeine/aggregate@1.0.0-pre.7

## 0.1.1-pre.6

### Patch Changes

- Updated dependencies [[`696b850`](https://github.com/surikaterna/redemeine/commit/696b850bcf181d6e0de6494e8c10f39479515117), [`696b850`](https://github.com/surikaterna/redemeine/commit/696b850bcf181d6e0de6494e8c10f39479515117), [`63c3068`](https://github.com/surikaterna/redemeine/commit/63c3068c39ed94ab9e047dacd88c5d8631ebc4d8)]:
  - @redemeine/aggregate@1.0.0-pre.6

## 0.1.1-pre.5

### Patch Changes

- Updated dependencies [[`72d0a7b`](https://github.com/surikaterna/redemeine/commit/72d0a7b8f3ca11413b06215d9076a27bc5c3fbdd)]:
  - @redemeine/aggregate@1.0.0-pre.5

## 0.1.1-pre.4

### Patch Changes

- Updated dependencies [[`ec16bcb`](https://github.com/surikaterna/redemeine/commit/ec16bcba7a193cd1ed687f48acc4a57ef72d4656), [`4d5f4de`](https://github.com/surikaterna/redemeine/commit/4d5f4de5ee0240a995396251a1cbde76bd471d4c), [`7c76529`](https://github.com/surikaterna/redemeine/commit/7c765293c17ba62fc89b701b96f8fb9c2aa20b76)]:
  - @redemeine/aggregate@1.0.0-pre.4

## 0.1.1-pre.3

### Patch Changes

- Updated dependencies [[`f929559`](https://github.com/surikaterna/redemeine/commit/f929559eaa5f5b902f8759d8b8330cd7d2e107a8), [`7f5c04f`](https://github.com/surikaterna/redemeine/commit/7f5c04f6272361f14a476ff670fe942672047e73)]:
  - @redemeine/aggregate@1.0.0-pre.3

## 0.1.1-pre.2

### Patch Changes

- Updated dependencies [[`7cf5217`](https://github.com/surikaterna/redemeine/commit/7cf5217b3be22dd81c92892c24bc8b9e017e72a3)]:
  - @redemeine/aggregate@0.2.0-pre.2

## 0.1.1-pre.1

### Patch Changes

- [#93](https://github.com/surikaterna/redemeine/pull/93) [`b425b78`](https://github.com/surikaterna/redemeine/commit/b425b786dbfec709a789b5a84a61590c91cca17f) Thanks [@spralle](https://github.com/spralle)! - Document that saga execution helpers propagate thrown handler errors and reserve failure result envelopes for token resolution failures.

- [#92](https://github.com/surikaterna/redemeine/pull/92) [`b902445`](https://github.com/surikaterna/redemeine/commit/b90244571a8d7934f5acb22b844b6f0d66d77dd2) Thanks [@spralle](https://github.com/spralle)! - Document the public saga API groups, ESM-only usage, prerelease stability caveats, and type-safety guidance.

- [#94](https://github.com/surikaterna/redemeine/pull/94) [`c9fbd23`](https://github.com/surikaterna/redemeine/commit/c9fbd231c9748812295a4d8122f94a46dd3b5e80) Thanks [@spralle](https://github.com/spralle)! - Separate saga definition token internals from execution handler internals while preserving root exports and legacy internal import paths.

- [#88](https://github.com/surikaterna/redemeine/pull/88) [`15373fa`](https://github.com/surikaterna/redemeine/commit/15373fab154f77123fee0345dce2362c713a9d26) Thanks [@spralle](https://github.com/spralle)! - Prepare @redemeine/aggregate and @redemeine/saga for prerelease publishing by using npm-compatible prerelease dependency metadata and generating saga declaration files.

- [#90](https://github.com/surikaterna/redemeine/pull/90) [`4d17590`](https://github.com/surikaterna/redemeine/commit/4d17590776e98161da557178ac7562e42dfb3d4e) Thanks [@spralle](https://github.com/spralle)! - Refactor saga handler execution internals into focused modules without changing public API or runtime behavior.

- [#127](https://github.com/surikaterna/redemeine/pull/127) [`0fac88c`](https://github.com/surikaterna/redemeine/commit/0fac88c5bcaeae48c164556f3a0f70f375233f77) Thanks [@spralle](https://github.com/spralle)! - Bundle testing's private projection runtime implementation while keeping public
  contracts external. Resolve aggregate and saga dependencies to the matching
  workspace release when packing with pnpm, instead of old prerelease pins.

- [#91](https://github.com/surikaterna/redemeine/pull/91) [`e0afb8a`](https://github.com/surikaterna/redemeine/commit/e0afb8aa5e88e2930a18c7a870383d76fb977762) Thanks [@spralle](https://github.com/spralle)! - Improve saga implementation type safety without changing public API or runtime behavior.

- [#99](https://github.com/surikaterna/redemeine/pull/99) [`3602d22`](https://github.com/surikaterna/redemeine/commit/3602d22a4961eba06af4712febd14f4248eb36ea) Thanks [@kennyek](https://github.com/kennyek)! - Replace bun with pnpm.

- Updated dependencies [[`15373fa`](https://github.com/surikaterna/redemeine/commit/15373fab154f77123fee0345dce2362c713a9d26), [`0fac88c`](https://github.com/surikaterna/redemeine/commit/0fac88c5bcaeae48c164556f3a0f70f375233f77), [`3602d22`](https://github.com/surikaterna/redemeine/commit/3602d22a4961eba06af4712febd14f4248eb36ea)]:
  - @redemeine/aggregate@0.2.0-pre.1

## 0.1.1-pre.0

### Patch Changes

- Updated dependencies []:
  - @redemeine/aggregate@0.2.0-pre.0
