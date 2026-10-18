# Corven Email SDK

Effect-native email library.

- [User documentation](docs/user/content/index.md) — Blume site, separate from contributor guidance.
- [Package entrypoints and commands](package.json)
- [Public exports](src/index.ts)
- [Implementation and behavioral tests](src/)
- [Typed API contracts](test/email-contracts.tst.ts)
- [Usage examples](examples/) — compiled, not executed.
- [HTTP provider authoring](docs/contributing/provider-authoring.md) — public contract and installed example.
- [Installed-package verification](scripts/check-package.sh)
- [Contributor instructions](AGENTS.md)
- [Reference sources](.agent-repos) — pinned source revisions for contributor research.

Preview the user documentation with `pnpm docs:dev`. Check content and links with `pnpm docs:check`, then build static HTML, search and LLM-readable output with `pnpm docs:build`. Output lives in `docs/user/dist/`, not the SDK's `dist/`. No deployment target is configured.
