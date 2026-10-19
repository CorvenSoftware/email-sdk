---
title: Lettermint
description: Send through a Lettermint route with native keys and sandbox-aware receipts.
---

Import `lettermintEmailLayer` from `@corvencore/email-sdk/lettermint` to provide the common `Email` service for this account.

## Configure the account

<include lang="ts">/_examples/provider-lettermint.ts.template</include>

The example reuses the [explicit HTTP Layer](/sending#configure-transport-behavior). Acquire credentials in trusted host code, then provide this account Layer to your sending program.

## Message behavior

- Use apiToken and, optionally, a route slug. A route slug selects provider configuration; it is not an SDK fallback route.
- Both explicit and provider-selected attachment MIME types are supported. Custom headers, metadata, scheduling and bounded ASCII tags are available.
- Sandbox acknowledgment is reported as Simulated. A sandbox delivered label is not live delivery evidence.

## Idempotency

Native idempotency applies to the configured account for 24 hours. Keys can contain up to 255 characters. The SDK stops retries after a payload conflict.

Read [field support](/providers/field-support) before switching accounts, and [receipts and retries](/reliability) before adding recovery behavior. Configuration and local validation do not authenticate the account or prove delivery.
