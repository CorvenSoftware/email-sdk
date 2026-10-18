---
title: Resend
description: Send literal messages through Resend with native idempotency and scheduling.
---

Import `resendEmailLayer` from `@corven/email-sdk/resend` to provide the common `Email` service for this account.

## Configure the account

<include lang="ts">/_examples/provider-resend.ts.template</include>

The example reuses the [explicit HTTP Layer](/sending#configure-transport-behavior). Acquire credentials in trusted host code, then provide this account Layer to your sending program.

## Message behavior

- Resend accepts unique custom headers, inline attachments and tags, but not common message metadata.
- Use a future schedule within 30 days. A parsed timestamp still has to pass the provider check at dispatch.

## Idempotency

Native idempotency applies to the configured account and unchanged request for 24 hours. Use the same key when retrying the operation.

Read [field support](/providers/field-support) before switching accounts, and [receipts and retries](/reliability) before adding recovery behavior. Configuration and local validation do not authenticate the account or prove delivery.
