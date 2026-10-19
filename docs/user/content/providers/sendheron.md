---
title: SendHeron
description: Choose SendHeron attachment policy and its corresponding replay guarantees.
---

Import `sendheronEmailLayer` from `@corvencore/email-sdk/sendheron` to provide the common `Email` service for this account.

## Configure the account

<include lang="ts">/_examples/provider-sendheron.ts.template</include>

The example reuses the [explicit HTTP Layer](/sending#configure-transport-behavior). Acquire credentials in trusted host code, then provide this account Layer to your sending program.

## Message behavior

- Authorize transactional provider tracking, and choose attachments Disabled when you need the native replay profile.
- Intent is constrained to HTML, a named sender, one plain to recipient and one plain reply-to address; CC and BCC are unsupported.
- Scheduled messages cannot include attachment bytes. Enabled attachments require explicit supported MIME types.
- An acknowledged suppression is terminal; do not work around it by choosing another provider.

## Idempotency

With attachments Disabled, native replay has a 24-hour retention window and keys up to 255 characters. With attachments enabled or unspecified, keys are only forwarded; unknown outcomes are not automatically replayable.

Read [field support](/providers/field-support) before switching accounts, and [receipts and retries](/reliability) before adding recovery behavior. Configuration and local validation do not authenticate the account or prove delivery.
