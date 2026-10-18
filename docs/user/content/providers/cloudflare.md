---
title: Cloudflare Email Sending
description: Use Cloudflare Email Sending through the REST API with explicit account and mail-flow settings.
---

Import `cloudflareEmailLayer` from `@corven/email-sdk/cloudflare` to provide the common `Email` service for this account.

## Configure the account

<include lang="ts">/_examples/provider-cloudflare.ts.template</include>

The example reuses the [explicit HTTP Layer](/sending#configure-transport-behavior). Acquire credentials in trusted host code, then provide this account Layer to your sending program.

## Message behavior

- This SDK entrypoint uses the REST API with accountId and apiToken. It does not implement a Workers email binding or inbound Email Routing.
- mailFlow attests to unmodified provider mail flow. Messages use constrained plain mailbox intent and one reply-to address.
- Custom headers are restricted; metadata, tags and scheduling are unsupported. Explicit MIME types and inline attachments are available.
- Queued, delivered and suppressed provider evidence is checked for coverage, but the resulting receipt is still submission evidence rather than inbox delivery.

## Idempotency

Idempotency keys are not supported. The SDK does not retry requests with unknown submission outcomes.

Read [field support](/providers/field-support) before switching accounts, and [receipts and retries](/reliability) before adding recovery behavior. Configuration and local validation do not authenticate the account or prove delivery.
