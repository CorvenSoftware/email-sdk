---
title: MailPace
description: Configure MailPace with supported headers, attachment types and tags.
---

Import `mailpaceEmailLayer` from `@corvencore/email-sdk/mailpace` to provide the common `Email` service for this account.

## Configure the account

<include lang="ts">/_examples/provider-mailpace.ts.template</include>

The example reuses the [explicit HTTP Layer](/sending#configure-transport-behavior). Acquire credentials in trusted host code, then provide this account Layer to your sending program.

## Message behavior

- Use serverToken for this entrypoint, not the apiKey option used by other providers.
- Only In-Reply-To, References and List-Unsubscribe custom headers are accepted. Use one plain reply-to address.
- Attachments require explicit MIME types and a supported filename extension. The adapter accepts tags but not common metadata or scheduling.
- The pending acknowledgment ID is a correlation handle, not delivery evidence.

## Idempotency

Idempotency keys are not supported. The SDK does not retry requests with unknown submission outcomes. Reconcile the result in your application before sending again.

Read [field support](/providers/field-support) before switching accounts, and [receipts and retries](/reliability) before adding recovery behavior. Configuration and local validation do not authenticate the account or prove delivery.
