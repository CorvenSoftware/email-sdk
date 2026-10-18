# Deploy the documentation

The documentation is a static Blume site. [deployment.json](../user/deployment.json) owns the target hostname. Both [Blume](../user/blume.config.ts) and the [Alchemy stack](../../alchemy.run.ts) read it, so generated canonical URLs and the Cloudflare custom domain use the same host.

The production site is [email-sdk.corvencore.com](https://email-sdk.corvencore.com). Before changing its hostname, confirm the new name is available in the existing `corvencore.com` Cloudflare zone. The stack does not create or adopt the zone, change its nameservers or configure email DNS records.

## Pipeline

[The documentation workflow](../../.github/workflows/docs.yml) runs on pull requests, pushes to `main` and manual dispatches:

- Validation installs the locked dependencies, runs the root check/test/build tasks and builds the documentation without Cloudflare credentials.
- Production deployment runs only for `main`, after validation succeeds. It downloads that run's static artifact rather than rebuilding with credentials present.
- Deployments share one concurrency group and do not cancel an active deployment. A commit that is no longer the `main` head is refused before deployment.
- The deploy job uses the `docs-production` GitHub environment. Configure its approval and branch restrictions before enabling the workflow; a YAML environment name alone does not enforce approval.
- Pull requests do not deploy previews, receive Cloudflare credentials or modify production resources. The workflow does not use `pull_request_target`.

The workflow uses Node and pnpm versions resolved from `package.json` and commit-pinned GitHub Actions. Alchemy and its Node platform peer are development dependencies, not SDK runtime dependencies. The workspace overrides keep Alchemy's Effect adapter dependencies aligned with the SDK's existing Effect version. The deployment script and workflow disable Alchemy telemetry; a bare Alchemy CLI invocation enables telemetry by default. The installed-package consumer checks remain a separate `pnpm check:package` command; the workflow does not run them.

## Configure Cloudflare and GitHub

1. Confirm the account ID for the Cloudflare account containing the active `corvencore.com` zone. A login email is not an account ID and is not needed by API-token authentication.
2. Choose an unused subdomain and update `deployment.json` if needed. Check existing Worker custom domains, routes and DNS records. Do not replace an existing service or remove conflicting records without separate approval.
3. Create a scoped, account-owned Cloudflare API token for that account. Account tokens act as service principals rather than depending on a user's membership. Set an expiration date and store the rotation deadline in environment variable `CLOUDFLARE_TOKEN_EXPIRES_ON`. This stack needs account-level **Workers Scripts: Edit** and **Secrets Store: Edit**, plus **Zone: Read** restricted to `corvencore.com` for hostname lookup. Alchemy calls these permissions `Workers Scripts Write`, `Secrets Store Write` and `Zone Read`. It does not need API-token administration, Pages, R2, D1, queues, email or general DNS-edit permissions.
4. In the repository settings, create the `docs-production` environment. Restrict deployments to `main` and add required reviewers. Prevent self-review when another eligible reviewer is available; a sole maintainer needs self-review enabled to approve their own push.
5. Add environment variable `CLOUDFLARE_ACCOUNT_ID` and environment secret `CLOUDFLARE_API_TOKEN`. Do not place the token in repository files, build artifacts, command arguments or logs.

These permissions are based on the pinned Alchemy provider and the Cloudflare [Worker-domain API](https://developers.cloudflare.com/api/resources/workers/subresources/domains/methods/update/). If account policy requires additional permissions, inspect the failing operation before expanding the token.

## Bootstrap state

The stack uses `Cloudflare.state()`. Its remote state is shared across CI runs and separated by stack name and stage. It is not a runner-local cache.

The pinned Alchemy release uses the account-wide `alchemy-state-store` Worker, a SQLite-backed Durable Object and Secrets Store entries for authentication and encryption. These supporting resources are shared by other Alchemy stacks in that account. Alchemy may create or upgrade them during bootstrap or deployment. Review existing users of the store before proceeding; do not destroy it to remove this documentation site.

Check the existing store's `/version` response against the pinned client's state protocol before deployment. Reuse a compatible store; a new application stack does not require a new bootstrap. Stop on a mismatch and review the other stacks using that store before allowing an upgrade.

Only when bootstrap is needed, approve the exact account, resources, permissions and possible usage charges, then use an authorized local API-token profile or securely supplied environment credentials:

```sh
ALCHEMY_TELEMETRY_DISABLED=1 pnpm exec alchemy provider cloudflare bootstrap
```

This command changes cloud resources. It is not a verification command. `alchemy plan` can also initialize remote state and must not be treated as an offline check.

A compatible remote store must be available before relying on unattended CI deployment. On CI, Alchemy resolves the remote-state credentials from Secrets Store. No local profile directory or `.alchemy/` contents are uploaded as workflow artifacts.

## Rotate the CI token

Create a replacement with the same account and zone scopes before the recorded expiration date. Update `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_TOKEN_EXPIRES_ON` in `docs-production`, validate an approved deployment, then revoke the replaced token. Keep the old token active until the replacement is verified. Never commit credential values or copy tokens into an issue, chat or build artifact.

## Verify and enable

```sh
pnpm install --frozen-lockfile
pnpm turbo run check test build
pnpm check:package
pnpm docs:build
```

Verify the built site locally, including HTML pages, Markdown mirrors, local search, `llms.txt`, sitemap URLs and the 404 page. If a docs dev server is running, use a separate repository-local verification copy for a complete production build; `blume build --isolated` does not emit every deployment artifact.

Publishing the workflow to `main` enables automatic deployments after validation and environment approval. Obtain approval before committing/pushing it or running the deploy command. A manual workflow dispatch must target `main`.

For an approved local deployment, first build the docs, then run:

```sh
pnpm docs:deploy
```

The stack accepts only the `prod` stage and serves the built files as an assets-only Worker. It disables `workers.dev` and Worker invocation logging. Cloudflare manages the custom-domain DNS record and TLS certificate. It does not provide server-rendered Markdown content negotiation; agents use the generated `.md` URLs.

After deployment, check the reported HTTPS URL, a nested guide, its `.md` mirror, search, `llms.txt`, sitemap and an unknown URL's 404 status. Local checks do not prove Cloudflare authentication, DNS or TLS readiness, deployment success or public availability.

Cloudflare can reject generic automated clients with [error 1010](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1010/). Identify authorized monitoring requests with a descriptive User-Agent and report any remaining blocked client types. Distinguish an edge-policy rejection from a missing asset; do not disable zone-wide protections to make a smoke check pass.
