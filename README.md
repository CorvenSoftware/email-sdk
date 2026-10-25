# Corven Email SDK

Send email from Effect programs with typed errors and provider Layers.

## Record your first email

Provide `recordingEmailLayer` to record a message without credentials, an HTTP client, or a provider account:

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

`result.receipt._tag` is `"Recorded"`. `result.messages` contains one message in memory. The recording Layer does not submit email to a provider.

For installation steps and the required Effect peer, see the [quickstart](docs/user/content/quickstart.md).

## Documentation and development

- [User documentation](https://email-sdk.corvencore.com). Guides and API reference.
- [Documentation source](docs/user/content/index.md). Blume content.
- [Package entrypoints and commands](package.json)
- [Public exports](src/index.ts)
- [Implementation and behavioral tests](src/)
- [Typed API contracts](test/email-contracts.tst.ts)
- [Usage examples](examples/). `pnpm check:examples` compiles these examples without running them.
- [HTTP provider authoring](docs/contributing/provider-authoring.md). Provider contract and installed example.
- [Installed-package verification](scripts/check-package.sh)
- [Package releases](docs/contributing/releases.md). Changesets, npm access, and trusted publishing.
- [Documentation deployment](docs/contributing/docs-deployment.md). Alchemy and GitHub Actions setup.
- [Contributor instructions](AGENTS.md)
- [Reference sources](.agent-repos). Pinned revisions for contributor research.
- [MIT license](LICENSE)

Use these commands to work on the documentation:

- `pnpm docs:dev` starts the local preview.
- `pnpm docs:check` checks content and links.
- `pnpm docs:build` writes static HTML, search, and LLM-readable output to `docs/user/dist/`.

To deploy the docs, follow [Documentation deployment](docs/contributing/docs-deployment.md). Deployment requires Cloudflare credentials and approval. The Alchemy stack uses the hostname in [deployment.json](docs/user/deployment.json).
