---
title: Postmark
description: Send through a Postmark message stream with repeated headers and metadata.
---

Import `postmarkEmailLayer` from `@corvencore/email-sdk/postmark` to provide the common `Email` service for this account.

## Configure the account

<include lang="ts">/_examples/provider-postmark.ts.template</include>

The example reuses the [explicit HTTP Layer](/sending#configure-transport-behavior). Acquire credentials in trusted host code, then provide this account Layer to your sending program.

## Message behavior

- Use a server submission token. The validation-only POSTMARK_API_TEST token is rejected at Layer acquisition.
- The default message stream is outbound. Only one tag is supported; tag names cannot contain a colon.
- Attachments require explicit MIME types. Scheduling is unsupported.

## Idempotency

This integration declares no send idempotency support. Supplying an idempotency key fails locally; an unknown result cannot be replayed or moved to another account.

Read [field support](/providers/field-support) before switching accounts, and [receipts and retries](/reliability) before adding recovery behavior. Configuration and local validation do not authenticate the account or prove delivery.
