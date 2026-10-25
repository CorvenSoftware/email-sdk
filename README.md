# Corven Email SDK

Send transactional email from TypeScript with Effect services, typed errors, and provider Layers. Prepare messages before submission, inspect provider outcomes, and configure retry and fallback behavior for each account.

## What it provides

- `Email` methods for validation, preparation, sending, batches, and personalization.
- Schemas for messages, options, receipts, and expected errors.
- Prepared operations that retain the message and options used for approval and submission.
- Named account routing that checks every selected account before submission.
- Ordered batch and Stream results with bounded concurrency.
- Recording and failing Layers for tests without provider calls.
- Optional React Email rendering and AI tool integrations through separate imports.

The SDK rejects unsupported message fields instead of removing them. Provider capabilities and replay guarantees remain account-specific.

## Install

Use Node.js 24.18.0 or later and Effect 4.0.3. The required versions are in [`package.json`](package.json).

The examples below use APIs in this checkout that have not reached the latest [npm release](https://www.npmjs.com/package/@corvencore/email-sdk). Build a package archive from this checkout:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm pack --out ./corven-email-sdk.tgz
```

In your application, install the archive and the matching Effect peer:

```sh
pnpm add /absolute/path/to/corven-email-sdk.tgz effect@4.0.3
```

React and React Email are optional. The recording and HTTP-provider examples do not need them.

## Record your first email

Provide `recordingEmailLayer` to run without credentials, an HTTP client, or a provider account:

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
console.log(result.receipt._tag, result.messages.length);
```

Save the code as `record-email.mts`. Run `node record-email.mts` from your application. The program prints `Recorded 1`.

`result.messages` contains one message in memory. The recording Layer does not submit email to a provider.

The application chooses when to run the Effect. Constructing `Email.send(...)` does not acquire an account or submit a request.

## Send through a provider

Provide an account Layer and an HTTP client. This example uses Resend and disables automatic redirects:

```ts
import { Effect, Layer } from "effect";
import type { Redacted } from "effect";
import { FetchHttpClient } from "effect/http";
import { Email } from "@corvencore/email-sdk";
import { resendEmailLayer } from "@corvencore/email-sdk/resend";

const emailHttpLayer = FetchHttpClient.layer.pipe(
  Layer.provide(Layer.succeed(FetchHttpClient.RequestInit, { redirect: "manual" })),
);

export const sendNotification = (apiKey: Redacted.Redacted) =>
  Email.send(
    {
      body: { text: "Your fictional order is ready." },
      from: "sender@example.test",
      subject: "Order ready",
      to: "recipient@example.test",
    },
    { idempotencyKey: "orders/order-42/ready" },
  ).pipe(Effect.provide(resendEmailLayer({ apiKey }).pipe(Layer.provide(emailHttpLayer))));
```

Before running the provider example:

1. Acquire the API key in trusted application code as a `Redacted` value.
2. Replace the fictional addresses with addresses your account can use.
3. Choose and persist an idempotency key for the logical event. Use a different key for each unrelated notification.

Call `sendNotification(apiKey)` to construct the Effect. Run the Effect in your application entrypoint to submit the request.

The SDK does not read credentials from the environment. Your application can use `Config.Redacted` to read configuration when it acquires a Layer. The [provider guide](docs/user/content/sending.md) covers configuration, transport settings, and changing providers.

## Providers

Provider Layers include Resend, Postmark, SendGrid, Mailgun, MailerSend, Amazon SES, Microsoft Graph, and SMTP. The [provider guides](docs/user/content/providers.md) list all supported providers and account settings.

Loops and Iterable use separate services for provider-managed templates and campaigns. They are not ordinary `Email` Layers or fallback targets.

Providers differ in attachment support, scheduling, headers, metadata, and idempotency. Check [message field support](docs/user/content/providers/field-support.md) before changing accounts.

## Prepare, route, and batch messages

Use these APIs for application workflows:

| Task                                             | API                                      | Guide                                                                                           |
| ------------------------------------------------ | ---------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Inspect a message before approval                | `Email.prepare`                          | [Prepared operations](docs/user/content/reference/email.md#prepared-operation)                  |
| Select named accounts and fallbacks              | `emailRouterLayer`, `EmailRouter.select` | [Account routing](docs/user/content/batching-routing.md#route-explicit-accounts)                |
| Check a route plan without sending               | `explainEmailRoutePlan`                  | [Route-plan checks](docs/user/content/batching-routing.md#explain-a-route-plan-without-sending) |
| Send independent messages                        | `Email.sendAll`, `sendEmailStream`       | [Batches and Streams](docs/user/content/batching-routing.md)                                    |
| Set a minimum interval between sender admissions | `pacedEmailSenderLayer`                  | [Account pacing](docs/user/content/reliability.md#pace-one-accounts-sender-attempts)            |
| Submit a native Resend batch                     | `ResendBatchEmail`                       | [Resend batches](docs/user/content/providers/resend.md#submit-one-native-batch)                 |

For approval, retain the prepared operation and submit that operation after approval. Do not recompute the message after review. Keep the Layer's scope open while the operation uses its resources.

`sendAll` and `sendEmailStream` preserve input order and return expected item failures as Effect Results. Defects and interruption propagate. The Stream helper prepares each request as it processes that request rather than waiting for a full batch.

## Handle submission outcomes

An `Accepted` receipt confirms a provider acknowledgment. It does not confirm delivery to the recipient.

`EmailDeliveryUnknown` means the provider may have accepted the request. Do not report the message as unsent or switch accounts to resend it. Replaying an unknown outcome requires native idempotency for the selected account and operation. Use the same scoped key and unchanged prepared intent. The policy and key age must stay within provider bounds.

Fallback requires an eligible definite rejection. Conflicts and terminal receipts stop fallback. An observer failure does not permit another submission.

The SDK does not provide a durable queue or exactly-once delivery. Your application stores outcomes, key creation times, and route selections for recovery. See [receipts, errors, and retries](docs/user/content/reliability.md).

## Documentation

The [documentation site](https://email-sdk.corvencore.com) contains task guides and API reference. The source guides describe the API in this checkout:

- [Quickstart](docs/user/content/quickstart.md)
- [Messages and attachments](docs/user/content/messages.md)
- [Services and Layers](docs/user/content/concepts/service-model.md)
- [Email service reference](docs/user/content/reference/email.md)
- [Routing reference](docs/user/content/reference/routing.md)
- [React Email](docs/user/content/integrations/react.md)
- [AI tools](docs/user/content/integrations/ai.md)
- [Provider authoring](docs/contributing/provider-authoring.md)

## Development

Run the repository checks from the checkout:

```sh
pnpm turbo run check test build
pnpm check:package
```

The checks compile examples against the installed package and run local recording, HTTP, and SMTP fixtures. They do not authenticate with live providers.

Use `pnpm docs:dev` to preview the documentation, `pnpm docs:check` to check content and links, and `pnpm docs:build` to build the site.

See [Contributor instructions](AGENTS.md), [package releases](docs/contributing/releases.md), and [documentation deployment](docs/contributing/docs-deployment.md) for the remaining workflows.

## License

[MIT](LICENSE).
