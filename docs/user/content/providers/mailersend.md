---
title: MailerSend
description: Send with MailerSend scheduling, repeated headers and suppression-aware receipts.
---

Import `mailersendEmailLayer` from `@corven/email-sdk/mailersend` to provide the common `Email` service for this account.

## Configure the account

<include lang="ts">/_examples/provider-mailersend.ts.template</include>

The example reuses the [explicit HTTP Layer](/sending#configure-transport-behavior). Acquire credentials in trusted host code, then provide this account Layer to your sending program.

## Message behavior

- Attachments delegate MIME selection to the provider: use ProviderSelected rather than an explicit content type.
- Use one reply-to mailbox. CC and BCC each have provider limits, and recipient names cannot contain commas or semicolons.
- Suppression warnings can produce partial or fully suppressed receipts. Preserve those partitions rather than treating them as retryable failures.

## Idempotency

Idempotency keys are not supported. The SDK does not retry requests with unknown outcomes or use a fallback account after a suppression result.

Read [field support](/providers/field-support) before switching accounts, and [receipts and retries](/reliability) before adding recovery behavior. Configuration and local validation do not authenticate the account or prove delivery.
