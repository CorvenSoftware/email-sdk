---
title: Scaleway
description: Configure a Scaleway project with constrained transactional message support.
---

Import `scalewayEmailLayer` from `@corvencore/email-sdk/scaleway` to provide the common `Email` service for this account.

## Configure the account

<include lang="ts">/_examples/provider-scaleway.ts.template</include>

The example reuses the [explicit HTTP Layer](/sending#configure-transport-behavior). Acquire credentials in trusted host code, then provide this account Layer to your sending program.

## Message behavior

- Use a UUID projectId and a Redacted secretKey. tracking attests that provider tracking is disabled.
- Attachments require explicit supported MIME types; inline placement, common metadata, tags and scheduling are unsupported.
- Content and mailbox intent pass additional provider rules. Use the acquired service for final local validation.
- Receipts preserve recipient outcomes and provider correlation instead of collapsing them to one sent flag.

## Idempotency

Idempotency keys are not supported. The SDK does not retry requests with unknown submission outcomes.

Read [field support](/providers/field-support) before switching accounts, and [receipts and retries](/reliability) before adding recovery behavior. Configuration and local validation do not authenticate the account or prove delivery.
