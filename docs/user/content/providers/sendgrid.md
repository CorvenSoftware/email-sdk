---
title: SendGrid
description: Configure SendGrid regional Mail Send and opt-in native personalization.
---

Import `sendgridEmailLayer` from `@corven/email-sdk/sendgrid` to provide the common `Email` service for this account.

## Configure the account

<include lang="ts">/_examples/provider-sendgrid.ts.template</include>

The example reuses the [explicit HTTP Layer](/sending#configure-transport-behavior). Acquire credentials in trusted host code, then provide this account Layer to your sending program.

## Message behavior

- Choose Global or Europe explicitly when account placement matters. Region selection does not create a new replay guarantee.
- Sender display names must be ASCII. Reserved X-SG-ID and X-SG-EID headers cannot be overridden.
- Schedules require a future whole UTC second within 72 hours. Metadata becomes custom arguments and tags become categories.
- For grouped audiences, use sendgridPersonalizedEmailLayer deliberately; see the personalization guide.

## Idempotency

Idempotency keys are not supported. The SDK does not retry requests with unknown submission outcomes.

Read [field support](/providers/field-support) before switching accounts, and [receipts and retries](/reliability) before adding recovery behavior. Configuration and local validation do not authenticate the account or prove delivery.
