---
title: Helo
description: Send through a Helo channel with explicit live or sandbox mode.
---

Import `heloEmailLayer` from `@corvencore/email-sdk/helo` to provide the common `Email` service for this account.

## Configure the account

<include lang="ts">/_examples/provider-helo.ts.template</include>

The example reuses the [explicit HTTP Layer](/sending#configure-transport-behavior). Acquire credentials in trusted host code, then provide this account Layer to your sending program.

## Message behavior

- Choose channelMode Live or Sandbox, and optionally supply a UUID channelId. The setting describes the selected channel; it does not create one.
- Custom headers cannot override Helo controls. Recipient addresses must be distinct so suppression evidence can be assigned correctly.
- Sandbox responses become Simulated. Live suppression evidence can produce partial or fully suppressed receipts.
- Scheduling is unsupported; metadata, inline attachments and bounded tags are supported.

## Idempotency

Native idempotency applies to the configured account and channel for one hour. Keys can contain up to 36 characters.

Read [field support](/providers/field-support) before switching accounts, and [receipts and retries](/reliability) before adding recovery behavior. Configuration and local validation do not authenticate the account or prove delivery.
