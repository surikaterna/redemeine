---
"@redemeine/demeine-interop": patch
---

Let generated no-payload shortcuts reach the legacy queue by normalizing missing
or undefined creator payloads to a fresh empty object on a copied envelope.
Preserve object pack identity and reject explicit null/scalar payloads as before.
The sink and builder contract see the same object; void-only contracts are not
bypassed and require an object-compatible contract at this legacy boundary.
