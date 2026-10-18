---
title: Lettr
description: Choose Lettr immediate or scheduled submission and preserve count-only outcomes.
---

Import `lettrEmailLayer` from `@corven/email-sdk/lettr` to provide the common `Email` service for this account.

## Configure the account

<include lang="ts">/_examples/provider-lettr.ts.template</include>

The example reuses the [explicit HTTP Layer](/sending#configure-transport-behavior). Acquire credentials in trusted host code, then provide this account Layer to your sending program.

## Message behavior

- Use a live lttr_ credential. Sandbox recipient rewriting is not supported.
- Immediate and Scheduled are different configured modes. Scheduled mode enables scheduling and requires the scheduled acknowledgment shape.
- Attachments require explicit MIME types. Inline attachments are unsupported; one tag and common metadata are available.
- Acceptance/rejection counts do not identify which recipients belong to each group. Preserve count-only receipts.

## Idempotency

Immediate mode declares native 24-hour replay using keys up to 255 characters containing only letters, digits, dots, underscores or hyphens. Scheduled mode declares no send key support.

Read [field support](/providers/field-support) before switching accounts, and [receipts and retries](/reliability) before adding recovery behavior. Configuration and local validation do not authenticate the account or prove delivery.
