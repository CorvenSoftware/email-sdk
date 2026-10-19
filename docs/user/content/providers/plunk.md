---
title: Plunk
description: Configure Plunk with explicit consent to contact upserts and provider-generated text.
---

Import `plunkEmailLayer` from `@corvencore/email-sdk/plunk` to provide the common `Email` service for this account.

## Configure the account

<include lang="ts">/_examples/provider-plunk.ts.template</include>

The example reuses the [explicit HTTP Layer](/sending#configure-transport-behavior). Acquire credentials in trusted host code, then provide this account Layer to your sending program.

## Message behavior

- Use a secret sk_ submission key. Public tracking keys are not accepted.
- contactWrites permits provider contact upserts; tracking attests that project tracking is disabled. Neither option changes remote settings.
- Plunk requires HTML and generates its own plain-text alternative. Supplying explicit text cannot preserve that intent and is rejected.
- Use one plain reply-to mailbox. Tags, common metadata and scheduling are unsupported.

## Idempotency

The adapter supports native idempotency within the configured account for 24 hours. Keys can contain up to 255 characters.

Read [field support](/providers/field-support) before switching accounts, and [receipts and retries](/reliability) before adding recovery behavior. Configuration and local validation do not authenticate the account or prove delivery.
