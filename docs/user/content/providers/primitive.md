---
title: Primitive
description: Configure Primitive key requirements without assuming its content deduplication is replay-safe.
---

Import `primitiveEmailLayer` from `@corven/email-sdk/primitive` to provide the common `Email` service for this account.

## Configure the account

<include lang="ts">/_examples/provider-primitive.ts.template</include>

The example reuses the [explicit HTTP Layer](/sending#configure-transport-behavior). Acquire credentials in trusted host code, then provide this account Layer to your sending program.

## Message behavior

- Use a prim_ submission key; prim_oat_ credentials are excluded by this adapter.
- Choose Reject to require caller keys, or explicitly AllowContentDeduplication for keyless sends. The latter permits provider content deduplication. The SDK still does not retry unknown submissions.
- Only Auto-Submitted, X-Auto-Response-Suppress and Precedence custom headers are accepted. Metadata, tags and scheduling are unsupported.
- Acknowledgments must describe a fresh submitted_to_agent operation with consistent recipient coverage.

## Idempotency

The adapter forwards keys of up to 255 characters. Its idempotency declaration is `KeyForwarding`. The SDK does not retry requests with unknown submission outcomes.

Read [field support](/providers/field-support) before switching accounts, and [receipts and retries](/reliability) before adding recovery behavior. Configuration and local validation do not authenticate the account or prove delivery.
