---
title: Microsoft Graph
description: Submit through a Microsoft Graph mailbox using a host-acquired access token.
---

Import `graphEmailLayer` from `@corven/email-sdk/graph` to provide the common `Email` service for this account.

## Configure the account

<include lang="ts">/_examples/provider-graph.ts.template</include>

The example reuses the [explicit HTTP Layer](/sending#configure-transport-behavior). Acquire credentials in trusted host code, then provide this account Layer to your sending program.

## Message behavior

- The host acquires and refreshes accessToken. This adapter does not implement OAuth client credentials, managed identity discovery or token refresh.
- Provide the mailbox UUID and address, attest OwnerOrSendAs permission and unmodified mail flow, and choose Save or DoNotSave for sent items.
- Graph represents one body format; incompatible dual-body intent is rejected instead of dropping a body. Common metadata, tags and scheduling are unsupported.
- An accepted `sendMail` response can omit the message ID. Store the receipt without adding an ID.

## Idempotency

Idempotency keys are not supported. The SDK does not retry `sendMail` requests with unknown submission outcomes.

Read [field support](/providers/field-support) before switching accounts, and [receipts and retries](/reliability) before adding recovery behavior. Configuration and local validation do not authenticate the account or prove delivery.
