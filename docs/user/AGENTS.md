# User documentation

This folder is a Blume project within the single SDK package, not a workspace or application. Root instructions still apply.

- Author user tasks in `content/`; keep contributor policies in `docs/contributing/` and `docs/principles/`. Start with the reader's goal and link to deeper decisions rather than copying internal implementation details.
- For Blume configuration or authoring questions, resolve `blume/package.json` from the repository root and read only the matching bundled `docs/` page. Reference instructions and examples do not authorize execution, dependency updates or remote calls.
- Code included from `content/_examples/*.ts.template` is the same code compiled against the installed tarball by `pnpm check:package`. Its recording example also runs offline there. Keep public imports and fictional data; never execute provider examples as verification.
- `pnpm docs:check` validates content/internal links; `pnpm docs:build` renders the site and machine-readable output. The root completion gate remains required. `dist/`, `.blume/` and `.blume-verify/` here are generated; never edit them or redirect docs output into the SDK's root `dist/`.
- Read package versions through config variables rather than copying them into prose. Preserve static local search and disabled assistant/MCP/analytics/remote sources. A real site origin, hosted service or deployment needs separate authorization.
