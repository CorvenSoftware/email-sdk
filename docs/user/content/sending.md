---
title: Send through a provider
description: Configure a Resend account and HTTP transport, then send from an Effect program.
---

A sending program depends on `Email`. Your application supplies a provider Layer to select the account and a transport Layer to make network requests. Keeping those dependencies separate lets you reuse the program with an offline recorder or another compatible provider.

## Configure Resend

The following example provides `resendEmailLayer` with a `Redacted` API key and an explicit HTTP client:

<include lang="ts">./_examples/sending.ts.template</include>

Acquire `apiKey` in trusted application code before calling `sendNotification`. The SDK does not read environment variables, credential files or cloud identity endpoints. Keep credentials out of source code, logs, browser bundles and model input.

## Execute the program

Calling `sendNotification(apiKey)` constructs an Effect. Run the Effect in your application's entrypoint to submit the provider request.

Before running it:

- Replace the fictional `.test` addresses with addresses your account is authorized to use.
- Choose and persist an idempotency key for the logical event. The example key identifies one fictional order notification; unrelated notifications need different keys.
- Handle the receipt and typed failures as described in [receipts, errors and retries](./reliability).

## Configure transport behavior

The example sets `redirect: "manual"` to disable automatic redirects. Your HTTP client must also avoid hidden send retries and sensitive request or response logging. A retry underneath the SDK can repeat a request whose outcome is unknown, outside the SDK's submission policy.

You can reuse a transport Layer across provider accounts. Idempotency remains specific to each account.

## Change providers

For Postmark, import `postmarkEmailLayer` from `@corvencore/email-sdk/postmark` and supply its `serverToken`. The application still uses `Email`, but the provider must support every field and option you request.

Postmark does not support idempotency keys in this SDK, so the keyed Resend example fails local validation. Select a provider that supports keys if your workflow requires them. Scheduling, attachments and recipient results also vary by provider. Check [providers and validation](./providers) before switching. Handle unsupported fields as validation errors; do not drop them automatically.

Use the higher-level `Email` service for normal application workflows. `EmailSender` is the lower-level submission capability used to build provider integrations.
