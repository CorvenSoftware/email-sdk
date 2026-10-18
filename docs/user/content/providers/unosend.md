---
title: Unosend
description: Send through Unosend with supported attachment MIME types and scheduling.
---

Import `unosendEmailLayer` from `@corven/email-sdk/unosend` to provide the common `Email` service for this account.

## Configure the account

<include lang="ts">/_examples/provider-unosend.ts.template</include>

The example reuses the [explicit HTTP Layer](/sending#configure-transport-behavior). Acquire credentials in trusted host code, then provide this account Layer to your sending program.

## Message behavior

- Use explicit MIME types from the supported set, including PDF, PNG, JPEG, CSV, plain text, ZIP, JSON and HTML.
- Inline attachments and common metadata are unsupported. Use at most one reply-to address.
- A successful response must carry a consistent success marker and data.id; an unrecognized response remains unknown.

## Idempotency

Idempotency keys are not supported. The SDK does not retry requests with unknown submission outcomes.

Read [field support](/providers/field-support) before switching accounts, and [receipts and retries](/reliability) before adding recovery behavior. Configuration and local validation do not authenticate the account or prove delivery.
