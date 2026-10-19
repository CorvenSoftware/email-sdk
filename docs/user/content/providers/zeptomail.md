---
title: ZeptoMail
description: Choose a ZeptoMail live or sandbox agent and preserve its acknowledgment scope.
---

Import `zeptomailEmailLayer` from `@corvencore/email-sdk/zeptomail` to provide the common `Email` service for this account.

## Configure the account

<include lang="ts">/_examples/provider-zeptomail.ts.template</include>

The example reuses the [explicit HTTP Layer](/sending#configure-transport-behavior). Acquire credentials in trusted host code, then provide this account Layer to your sending program.

## Message behavior

- agentMode describes the selected mail agent. Live and Sandbox produce different receipt meanings; the SDK does not toggle the remote agent.
- Explicit MIME types, inline attachments and unique headers are supported. Metadata, tags and scheduling are unsupported.
- Provider attachment extension restrictions still apply after common attachment validation.

## Idempotency

The adapter declares no send key support. A sandbox acknowledgment is Simulated, not evidence of live acceptance or delivery.

Read [field support](/providers/field-support) before switching accounts, and [receipts and retries](/reliability) before adding recovery behavior. Configuration and local validation do not authenticate the account or prove delivery.
