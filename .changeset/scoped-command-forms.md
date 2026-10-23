---
"@redemeine/aggregate": patch
"@redemeine/mirage": patch
---

Preserve authored packed/shorthand command forms in entity command types. Selected Mirage commands inject only identity fields for object payloads, retaining required business fields, while packed commands omit the selected identity prefix. Reject conflicting caller identity on selected object commands instead of overriding selection.
