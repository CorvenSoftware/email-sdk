---
title: Brevo
description: Configure Brevo transactional messages, provider rendering and tracking.
---

Import `brevoEmailLayer` from `@corvencore/email-sdk/brevo` to provide the common `Email` service for this account.

## Configure the account

<include lang="ts">/_examples/provider-brevo.ts.template</include>

The example reuses the [explicit HTTP Layer](/sending#configure-transport-behavior). Acquire credentials in trusted host code, then provide this account Layer to your sending program.

## Message behavior

- Configure the application to permit provider rendering and tracking. The SDK does not inspect remote account settings.
- Attachments use ProviderSelected MIME selection. Inline placement, common metadata and tags are unsupported.
- Use one reply identity. Display names and scheduling must pass Brevo-specific validation.

## Idempotency

Idempotency keys are not supported. The SDK does not retry requests with unknown submission outcomes.

Read [field support](/providers/field-support) before switching accounts, and [receipts and retries](/reliability) before adding recovery behavior. Configuration and local validation do not authenticate the account or prove delivery.
