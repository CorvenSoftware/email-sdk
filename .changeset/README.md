# Changesets

Run `pnpm changeset` for a caller-visible SDK change. Select `@corvencore/email-sdk`, choose a version bump and describe the change for users. Commit the generated Markdown file with the change.

Use a patch for compatible fixes, a minor for new capabilities, and a major for breaking changes. During `0.x` development, use a minor for breaking changes and describe the migration. Documentation-only and development-tooling changes do not need a package release or an empty changeset.

`pnpm release:status` previews pending releases. The release workflow opens a version PR, then publishes the reviewed version after that PR is merged and the protected npm environment is approved.

See [Package releases](../docs/contributing/releases.md) for first-publication prerequisites and trusted-publisher configuration. The SDK remains private until its license and npm access are confirmed.
