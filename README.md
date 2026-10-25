# Corven Email SDK

Effect-native email with explicit submission evidence and replay safety.

## Record your first email

Use the recording Layer without credentials, an HTTP client, or a provider account:

```ts
import { Effect } from "effect";
import { Email } from "@corvencore/email-sdk";
import { RecordedEmails, recordingEmailLayer } from "@corvencore/email-sdk/testing";

const recordNotification = Effect.gen(function* recordNotification() {
  const records = yield* RecordedEmails;
  const receipt = yield* Email.send({
    body: { text: "Your fictional order is ready." },
    from: "sender@example.test",
    subject: "Order ready",
    to: "recipient@example.test",
  });
  const messages = yield* records.messages;

  return { messages, receipt };
}).pipe(Effect.provide(recordingEmailLayer));

const result = await Effect.runPromise(recordNotification);
```

`result.receipt` is `Recorded`, and `result.messages` contains one local message. Nothing was sent to a provider. Recording is not acceptance or delivery.

Follow the [quickstart](docs/user/content/quickstart.md) for local package installation and the matching Effect peer. This example uses the same public imports and recording workflow as the installed-package checks.

## Documentation and development

- [User documentation](https://email-sdk.corvencore.com) — guides and public API reference.
- [Documentation source](docs/user/content/index.md) — Blume content, separate from contributor guidance.
- [Package entrypoints and commands](package.json)
- [Public exports](src/index.ts)
- [Implementation and behavioral tests](src/)
- [Typed API contracts](test/email-contracts.tst.ts)
- [Usage examples](examples/) — compiled, not executed.
- [HTTP provider authoring](docs/contributing/provider-authoring.md) — public contract and installed example.
- [Installed-package verification](scripts/check-package.sh)
- [Package releases](docs/contributing/releases.md) — Changesets, npm access and trusted publishing.
- [Documentation deployment](docs/contributing/docs-deployment.md) — Alchemy and GitHub Actions setup.
- [Contributor instructions](AGENTS.md)
- [Reference sources](.agent-repos) — pinned source revisions for contributor research.
- [MIT license](LICENSE)

Preview the user documentation with `pnpm docs:dev`. Check content and links with `pnpm docs:check`, then build static HTML, search and LLM-readable output with `pnpm docs:build`. Output lives in `docs/user/dist/`, not the SDK's `dist/`. The Alchemy stack targets the hostname in [deployment.json](docs/user/deployment.json); deployment requires Cloudflare credentials and approval.
