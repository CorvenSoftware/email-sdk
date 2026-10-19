---
title: Sequenzy
description: Configure HTML sends with provider-managed profiles, rendering and retention.
---

Import `sequenzyEmailLayer` from `@corvencore/email-sdk/sequenzy` to provide the common `Email` service for this account.

## Configure the account

<include lang="ts">/_examples/provider-sequenzy.ts.template</include>

The example reuses the [explicit HTTP Layer](/sending#configure-transport-behavior). Acquire credentials in trusted host code, then provide this account Layer to your sending program.

## Message behavior

- Configure an existing verified sender profile and explicitly authorize provider-managed profiles, rendering and retention. Automatic UTM and reply tracking must be disabled remotely.
- The sender needs a display name, recipients must be plain and distinct across groups, and exactly one reply-to identity is required.
- Only HTML is representable: explicit plain text, custom headers, common metadata, tags and scheduling are rejected.
- Both attachment MIME modes are supported, without inline placement.

## Idempotency

Native idempotency applies to the configured account for 14 days. Keys can contain up to 255 characters. The SDK stops retries after an idempotency conflict.

Read [field support](/providers/field-support) before switching accounts, and [receipts and retries](/reliability) before adding recovery behavior. Configuration and local validation do not authenticate the account or prove delivery.
