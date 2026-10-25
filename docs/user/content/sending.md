---
title: Send through a provider
description: Configure a provider account and HTTP client, then send an email from Effect.
---

To send email through Resend, provide an account Layer and an HTTP client to your `Email` program.

## Configure Resend

Keep API keys out of source code, logs, browser bundles, and model input. Acquire the key in trusted application code.

Pass a `Redacted` API key to `resendEmailLayer`. Provide an HTTP client to the account Layer:

<include lang="ts">./_examples/sending.ts.template</include>

The SDK does not read environment variables, credential files, or cloud identity endpoints.

## Execute the program

Before you run the example:

1. Replace the fictional `.test` addresses with addresses your account can use.
2. Choose and persist an idempotency key for the logical event. The example key identifies one fictional order notification. Use a different key for each unrelated notification.
3. Handle the receipt and typed failures as described in [receipts, errors, and retries](./reliability).

Call `sendNotification(apiKey)` to construct the Effect. Run the Effect in your application entrypoint to submit the request.

## Configure transport behavior

Set `redirect: "manual"` on the HTTP client to disable automatic redirects, as the example does. Disable hidden send retries and sensitive request or response logs in the client.

A transport retry can repeat a submission after an unknown outcome, outside the SDK's submission policy. For retry behavior, see [receipts, errors, and retries](./reliability).

Reuse a transport Layer across accounts if they share the same transport settings. Keep idempotency keys and replay guarantees scoped to each account.

## Read configuration with Effect

If your application reads the API key from configuration, use `Config.Redacted` inside `Layer.unwrap`:

<include lang="ts">./_examples/effect-configuration.ts.template</include>

Provide an HTTP client when you use `configuredResendAccount`. Layer acquisition reads the key and reports missing configuration through the typed error channel.

## Build an Email Layer from a sender

If you have an `EmailSender` Layer, pass it to `emailLayerFromSender`:

<include lang="ts">./_examples/effect-native.ts.template</include>

Run `recordWithEffect` from your application entrypoint. The example records the message locally and returns a `Recorded` receipt. It does not submit email to a provider.

For the helper's types and scope rules, see the [Email service reference](/reference/email#sender-layer).

## Change providers

Before you change providers, check the required fields and options against [provider support](./providers).

For Postmark, import `postmarkEmailLayer` from `@corvencore/email-sdk/postmark` and supply its `serverToken`. Continue to use `Email` in your program.

Postmark does not support idempotency keys in this SDK. The keyed Resend example therefore fails local validation with Postmark. If your workflow requires keys, select a provider that supports them.

Scheduling, attachments, and recipient results also vary by provider. Handle unsupported fields as validation errors. Do not remove those fields to make a submission succeed.
