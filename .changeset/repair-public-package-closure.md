---
"@redemeine/testing": patch
"@redemeine/aggregate": patch
"@redemeine/saga": patch
---

Bundle testing's private projection runtime implementation while keeping public
contracts external. Resolve aggregate and saga dependencies to the matching
workspace release when packing with pnpm, instead of old prerelease pins.
