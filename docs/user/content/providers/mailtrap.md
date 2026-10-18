---
title: Mailtrap
description: Send through Mailtrap Email Sending while preserving all acknowledgment IDs.
---

Import `mailtrapEmailLayer` from `@corven/email-sdk/mailtrap` to provide the common `Email` service for this account.

## Configure the account

<include lang="ts">/_examples/provider-mailtrap.ts.template</include>

The example reuses the [explicit HTTP Layer](/sending#configure-transport-behavior). Acquire credentials in trusted host code, then provide this account Layer to your sending program.

## Message behavior

- This entrypoint uses Email Sending, not an implicit local inbox or sandbox transport.
- Attest that automatic BCC, footer insertion and tracking are disabled for the sending domain. The SDK does not inspect those settings.
- Attachments support both MIME modes and inline placement. Metadata and one category tag are supported; scheduling is not.
- Keep every ID in AcceptedWithIds. ID order does not map IDs to recipients.

## Idempotency

This adapter declares no send key support. Multiple message IDs are correlation evidence, not replay permission.

Read [field support](/providers/field-support) before switching accounts, and [receipts and retries](/reliability) before adding recovery behavior. Configuration and local validation do not authenticate the account or prove delivery.
