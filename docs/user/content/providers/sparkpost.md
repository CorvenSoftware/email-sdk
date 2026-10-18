---
title: SparkPost
description: Configure SparkPost transmissions with count-aware acknowledgment and regional transport.
---

Import `sparkpostEmailLayer` from `@corven/email-sdk/sparkpost` to provide the common `Email` service for this account.

## Configure the account

<include lang="ts">/_examples/provider-sparkpost.ts.template</include>

The example reuses the [explicit HTTP Layer](/sending#configure-transport-behavior). Acquire credentials in trusted host code, then provide this account Layer to your sending program.

## Message behavior

- Choose UnitedStates or Europe for the matching account. Messages support explicit MIME types, inline attachments, unique headers, metadata and scheduling.
- Common tags are unsupported by this integration. Do not replace them with substitution data to obtain a successful send.
- Recipient acceptance counts remain count-only evidence; the transmission ID does not establish recipient identity.

## Idempotency

Native idempotency applies for 24 hours. Keys can contain up to 255 letters, digits, dots, underscores or hyphens.

Read [field support](/providers/field-support) before switching accounts, and [receipts and retries](/reliability) before adding recovery behavior. Configuration and local validation do not authenticate the account or prove delivery.
