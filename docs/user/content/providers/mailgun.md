---
title: Mailgun
description: Send multipart messages through a Mailgun sending domain and region.
---

Import `mailgunEmailLayer` from `@corven/email-sdk/mailgun` to provide the common `Email` service for this account.

## Configure the account

<include lang="ts">/_examples/provider-mailgun.ts.template</include>

The example reuses the [explicit HTTP Layer](/sending#configure-transport-behavior). Acquire credentials in trusted host code, then provide this account Layer to your sending program.

## Message behavior

- The domain is a lowercase ASCII DNS name, not an API URL or account credential. Choose UnitedStates or Europe for the matching account.
- Custom headers retain repeated names. Metadata maps to v: fields and tags to o:tag; control headers cannot override SDK submission controls.
- Inline content IDs must equal the preserved filename. Scheduling requires whole seconds and a representable RFC-2822 year.
- mailgunPersonalizedEmailLayer is a separate opt-in native audience mode.

## Idempotency

Idempotency keys are not supported. The SDK does not retry requests with unknown submission outcomes.

Read [field support](/providers/field-support) before switching accounts, and [receipts and retries](/reliability) before adding recovery behavior. Configuration and local validation do not authenticate the account or prove delivery.
