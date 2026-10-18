---
title: JetEmail
description: Configure JetEmail transactional credentials, domain settings and idempotency key forwarding.
---

Import `jetemailEmailLayer` from `@corven/email-sdk/jetemail` to provide the common `Email` service for this account.

## Configure the account

<include lang="ts">/_examples/provider-jetemail.ts.template</include>

The example reuses the [explicit HTTP Layer](/sending#configure-transport-behavior). Acquire credentials in trusted host code, then provide this account Layer to your sending program.

## Message behavior

- Use a transactional_ submission token. Attest that domain automatic BCC and tracking are disabled before supplying these options.
- The sender requires an explicit display name; to recipients use plain mailboxes. Scheduled instants require whole seconds.
- Attachments use ProviderSelected MIME selection. Inline attachments, common metadata and tags are unsupported.
- deliveryRegion may be ProviderSelected or Europe; it does not establish cross-account deduplication.

## Idempotency

The adapter forwards keys of up to 256 characters. Its idempotency declaration is `KeyForwarding`. The SDK does not retry requests with unknown submission outcomes.

Read [field support](/providers/field-support) before switching accounts, and [receipts and retries](/reliability) before adding recovery behavior. Configuration and local validation do not authenticate the account or prove delivery.
