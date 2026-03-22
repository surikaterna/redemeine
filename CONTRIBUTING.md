# Contributing to Redemeine

Welcome to Redemeine! We are thrilled you are here and looking to contribute. 

Redemeine is built fundamentally as an **"IDE-First"** library. For us, type-safety and the developer's hover-tooltips are our primary user interface. When you contribute to this project, you are expected to maintain the absolute highest standards of Developer Experience (DX).

---

## 📖 The 3 Golden Rules of TSDoc

Because our users rely heavily on their IDE (like VS Code) to understand how to use this framework, every public interface, type, and exported function must be documented thoroughly. 

Whenever you add or modify a public method, you **must** adhere to the following three golden rules:

> ### **Rule 1: Favor `@example` over paragraphs.**
> Developers read code significantly faster than they read English. Every single public method MUST include an `@example` block demonstrating a highly realistic domain use case (use domain examples like `Order`, `Shipment`, or `ShoppingCart`—avoid generic `Foo`/`Bar` or `Counter` unless strictly applicable).

> ### **Rule 2: Document the "Magic".**
> Our library does a lot of heavy lifting under the hood. If a method interacts with the **"Targeted Naming" engine** (e.g., automatically transforming `camelCase` method keys into `dot.notation` strings) or injects specialized contexts (like **"Scoped Selectors"**), you must explicitly state that behavior in the TSDoc so it isn't a surprise to the user.

> ### **Rule 3: Skip the Obvious (No Noise).**
> Do not pollute the hover-tooltips with redundant information. 
> 🚫 **FORBIDDEN:** `/** @param payload - The payload */` or `/** @param state - The state */`. 
> 
> Rely on TypeScript's natural type inference to explain *what* a parameter is. Instead, use TSDoc to explain the *intent* and *mutability* (e.g., explicitly stating, *"State is wrapped in Immer here, you CAN mutate it"* vs *"State is ReadonlyDeep here, do NOT mutate"*).

---

## 💻 The Development Workflow

Our workflow follows the standard GitHub Flow model:

1. **Fork** the repository and create your feature branch from `main`.
2. **Clone** your fork locally.
3. Install dependencies using strictly `npm ci` to respect the lockfile.
4. Run tests frequently:
    ```bash
    npm test
    ```
5. Commit your changes and open a **Pull Request**.

---

## 🤖 The AI Audit Pipeline (CRITICAL)

Redemeine is actively crawled and analyzed to generate AI-readable context files (`llms.txt`). To ensure that our AI assistants and human developers stay perfectly in sync, we strictly enforce our TSDoc rules using an automated Documentation CI/CD Pipeline.

Before opening a PR, you **must** verify your documentation locally using our reflection analyzer:

```bash
npx ts-node bin/redemeine-reflector.ts --verify-tsdoc
```

*If this script fails, the CI action will block your Pull Request.*

### API Drift & `llms.txt`
If your Pull Request modifies the core Builder API (adding or removing methods), the automated GitHub Action will detect the API drift and automatically append a commit to your branch updating the AI-context `llms.txt` file. 

**Note on docs:** While `llms.txt` is updated automatically for AI, *you* are still responsible for ensuring the human-readable Markdown files in the `/docs` folder accurately reflect your changes.

---

Thank you for helping us keep Redemeine clean, type-safe, and incredibly easy to use!