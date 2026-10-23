---
title: Resend
description: Send literal messages through Resend with native idempotency and scheduling.
---

Import `resendEmailLayer` from `@corvencore/email-sdk/resend` to provide the common `Email` service for this account.

## Configure the account

<include lang="ts">/_examples/provider-resend.ts.template</include>

The example reuses the [explicit HTTP Layer](/sending#configure-transport-behavior). Acquire credentials in trusted host code, then provide this account Layer to your sending program.

## Message behavior

- Resend accepts unique custom headers, inline attachments and tags, but not common message metadata.
- Use a future schedule within 30 days. A parsed timestamp still has to pass the provider check at dispatch.

## Submit one native batch

`ResendBatchEmail` is a separate capability for one request containing 1 through 100 rendered messages. Provide it with `resendBatchEmailLayer({ apiKey })` and an explicit HTTP client.

<include lang="ts">/_examples/resend-batch.ts.template</include>

This pilot uses strict batch validation. It rejects attachments, scheduling, and common metadata before transport. Every message must pass local validation before the request starts. The ordinary Resend sender retains its existing attachment and scheduling support.

The operation returns ordered Effect Results. A proven ID produces an `Accepted` receipt for its position. Missing, malformed, or duplicated IDs leave the affected positions unknown. Request-level rejection or uncertainty fails the operation. Preserve any returned receipts when another position is unknown.

Only a batch-wide idempotency key is accepted. It identifies the complete unchanged request. Per-message keys and delivery policies are unsupported. The pilot sends one request and does not split, retry, or fall back automatically. Host transports must not add hidden retries or redirects. Native batches do not pass through individual-sender pacing or routing.

The [Resend batch reference](https://resend.com/docs/api-reference/emails/send-batch-emails) defines positional response IDs and provider limits. Resend's [idempotency documentation](https://resend.com/docs/dashboard/emails/idempotency-keys) defines request-key scope and retention. Neither document proves delivery.

## Idempotency

Native idempotency applies to the configured account and unchanged request for 24 hours. Use the same key when retrying the operation.

Read [field support](/providers/field-support) before switching accounts, and [receipts and retries](/reliability) before adding recovery behavior. Configuration and local validation do not authenticate the account or prove delivery.
