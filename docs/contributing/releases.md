# Package releases

Changesets manages SDK versions and changelogs. The release workflow in [release.yml](../../.github/workflows/release.yml) opens a version PR, validates a release tarball and publishes it to npm after environment approval. Documentation deployment remains a separate workflow.

## First-publication prerequisites

The SDK license is recorded in [package.json](../../package.json) and the root [LICENSE](../../LICENSE). The manifest permits public publication through the protected release workflow or an explicitly approved first-publication bootstrap. The maintainer owns the `corvencore` npm organization, which enforces 2FA for members. Organization membership and npm authentication remain separate from GitHub App authentication.

Before enabling publication:

1. Confirm the authenticated npm account has publish access to `@corvencore/email-sdk` through the `corvencore` organization. Keep organization ownership and 2FA enforcement under maintainer control; do not invite additional members or broaden team access as part of a release.
2. Confirm the SDK's SPDX license identifier in `package.json` agrees with the full text in the root `LICENSE`. Preserve third-party license files; they do not license the SDK.
3. Verify `private` is `false` and keep the package's explicit public access and registry settings. Review the packed file list and retain the public `./provider` export and optional integration isolation.
4. Create the GitHub environment `npm-production`. Require a maintainer review, restrict it to `main` and allow sole-maintainer self-review only if needed. A workflow environment name alone does not configure these protections.
5. Configure the repository-scoped release GitHub App described below. Organization policy blocks version PR creation with the built-in token; do not relax that organization-wide policy to enable this repository.
6. Review and authorize committing and pushing the release setup. Confirm the approved revision is the current remote `main` before the first publication.

npm requires an existing package before its trusted-publisher settings can be configured. Bootstrap the first real version with an authenticated, authorized maintainer account and interactive 2FA. Do not publish an empty placeholder as the SDK's normal release.

After the prerequisites are satisfied, run the full gate and publish the exact checked archive from a temporary directory:

```sh
pnpm install --frozen-lockfile
pnpm turbo run check test build
stage=$(mktemp -d)
pnpm pack --out "$stage/email-sdk.tgz"
pnpm check:package "$stage/email-sdk.tgz"
npm login --registry=https://registry.npmjs.org/
npm publish "$stage/email-sdk.tgz" --access public --registry=https://registry.npmjs.org/
```

The final command publishes publicly and must not run until the version, license, scope and source revision are approved. A local bootstrap publication does not have GitHub Actions provenance. If first-release provenance is required, arrange a separately approved one-time authenticated CI bootstrap instead; remove its credential after use. The normal pipeline below uses OIDC and requires no npm secret.

Confirm the published version, dist-tag, repository metadata and downloadable archive before creating its release tag and GitHub release. An upload error can leave the outcome uncertain; inspect npm before retrying. Published versions cannot be reused.

## Configure version PR automation

The organization's Actions policy prevents `GITHUB_TOKEN` from creating pull requests. The version job instead uses the private [Corven Email SDK Releases App](https://github.com/organizations/CorvenSoftware/settings/apps/corven-email-sdk-releases), installed only on this repository. The built-in job token retains read-only contents access, and no organization-wide policy change is required.

Keep the App private and installed on **only** `CorvenSoftware/email-sdk`. Grant repository **Contents: read and write** and **Pull requests: read and write**. Metadata read access is implicit. Do not grant workflow, administration or organization permissions.

Configure these repository settings:

| Setting          | Name                      | Value                 |
| ---------------- | ------------------------- | --------------------- |
| Actions variable | `RELEASE_APP_CLIENT_ID`   | The App's client ID   |
| Actions secret   | `RELEASE_APP_PRIVATE_KEY` | The App's private key |

Keep the private key out of files, logs, arguments and artifacts. The pinned token action requests only the two required permissions for `email-sdk`; installation tokens expire after one hour and are revoked when the job completes. Rotate the App's signing key through GitHub and replace the encrypted repository secret when needed.

App-authenticated version PRs trigger the normal PR validation workflow. The App does not approve or merge PRs and is not used for npm publication. Its repository variable and encrypted secret are configured. The normal workflow selects a version PR for pending changesets, publication for an unpublished manifest version, or no operation when npm is up to date.

Verify App authentication after setup or key rotation without creating a PR or publishing a package:

```sh
gh workflow run release.yml --ref main -f verify_release_app=true
```

This opt-in mode only mints a short-lived token with the required contents/PR permissions, checks that it can access this repository alone and revokes it at job completion. Version selection, packing and publication jobs are disabled in this mode. It verifies App authentication, not release-PR creation or npm authentication.

## Configure npm trusted publishing

In the package's npm Settings, add a GitHub Actions trusted publisher:

| Field                | Value                      |
| -------------------- | -------------------------- |
| Organization or user | `CorvenSoftware`           |
| Repository           | `email-sdk`                |
| Workflow filename    | `release.yml`              |
| Environment name     | `npm-production`           |
| Allowed actions      | Allow direct `npm publish` |

The workflow runs on GitHub-hosted runners. Only the publish job receives `id-token: write`. It publishes checked tarballs, requests provenance and creates GitHub releases and version tags. It does not rebuild the SDK in the publishing job or receive `NPM_TOKEN` or `NODE_AUTH_TOKEN`. Dependency caches are disabled throughout the release workflow, and lifecycle scripts are disabled outside the unprivileged build job.

A new trusted-publisher configuration must complete a successful publish within two days or it expires. After confirming OIDC publication works, set npm publishing access to **Require two-factor authentication and disallow tokens**. Do not disable interactive 2FA or create a standing bypass token.

Changesets currently does not support npm staged publishing. Do not configure this workflow's publisher as stage-only: the publish command would be denied. The GitHub environment review protects the direct-publication step.

## Release an SDK change

Run `pnpm changeset` with a caller-visible change. Select the SDK, choose a bump and write a user-facing summary. Commit the changeset with the implementation. `pnpm release:status` shows pending release intent. Changesets compares against `origin/main`, preserving the separate local `main` branch that holds the pre-publication history; fetch the remote before comparing.

Use patch releases for compatible fixes, minor releases for new capabilities and major releases for breaking changes. While the SDK is `0.x`, use a minor for breaking changes and describe migration steps. Contributor-documentation and development-tooling changes do not require a package release. The workflow does not block those PRs for missing changesets.

After changesets reach `main`, the workflow opens or updates a version PR. It updates the version, generates `CHANGELOG.md`, consumes the changesets and synchronizes the lockfile. Review that PR; do not edit the published version manually or bypass the checks.

Wait for the Documentation workflow's validation checks on the App-created `changeset-release/main` PR before merging it. The release pack job also repeats the SDK gate on the merged commit. Do not replace the App token with a personal token or the built-in token: personal tokens broaden credential exposure, while the built-in token is blocked by organization policy and does not trigger the normal PR workflows.

When the version PR is merged, the release workflow checks, tests and builds from the lockfile. Changesets packs the unpublished version. The existing independent ESM/CommonJS, provider-authoring, optional AI/React, documentation-example and CLI consumers run against that same archive. The protected publish job receives the artifact only after those checks pass. It rejects a superseded `main` commit before publishing. No email is sent and no model is called by these checks.

Approve `npm-production` only after reviewing the workflow SHA and version. After completion, verify the npm version and provenance, the `latest` dist-tag and the GitHub release/tag. A green local check is not evidence of npm authentication, trusted-publisher acceptance or a public release.

## Retry and recovery

A workflow can be manually dispatched on `main`. Changesets compares the manifest version with npm and normally skips versions already published. Publishing is serialized and active runs are not cancelled. A superseded run must not publish; start a fresh run for the current `main` commit.

If npm publication succeeded but GitHub release creation failed, verify the registry version and restore only the missing tag/release for the original source revision. Do not bump or republish just to repair GitHub metadata. Never unpublish or move an existing release tag without a separate decision.

For local archive checks, `pnpm check:package` builds and packs as before. `pnpm check:package /absolute/path/package.tgz` instead verifies an existing tarball without rebuilding or repacking it. Consumer dependency installation is offline by default. CI explicitly sets `PACKAGE_CHECK_ALLOW_NETWORK=1` so generated consumers can fetch missing public transitive dependencies; the SDK build and release tooling still use the frozen root lockfile. Optional integration dependencies are added with pnpm so the generated consumer manifest and lockfile stay synchronized, including in CI mode. Keep the temporary archive until registry verification is complete, then remove the owned temporary directory.

References: [Changesets automation](https://changesets.dev/guide/automating), [npm trusted publishing](https://docs.npmjs.com/trusted-publishers), [npm provenance](https://docs.npmjs.com/generating-provenance-statements).
