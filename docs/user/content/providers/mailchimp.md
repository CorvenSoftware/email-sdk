---
title: Mailchimp Transactional
description: Send through Mailchimp Transactional with explicit account behavior and recipient outcomes.
---

Import `mailchimpEmailLayer` from `@corven/email-sdk/mailchimp` to provide the common `Email` service for this account.

## Configure the account

<include lang="ts">/_examples/provider-mailchimp.ts.template</include>

The example reuses the [explicit HTTP Layer](/sending#configure-transport-behavior). Acquire credentials in trusted host code, then provide this account Layer to your sending program.

## Message behavior

- Use a live key and attest that account message rules and automatic footer insertion are disabled.
- Per-recipient acknowledgments retain accepted and rejected evidence. Queue status does not prove delivery.
- Tags are disabled by default. The optional tagStatistics configuration authorizes only a declared set of known account tag labels.
- Explicit MIME types, inline attachments, metadata and scheduling are supported subject to provider validation.

## Idempotency

The adapter declares no send idempotency support. A recipient message ID or queued result does not authorize another submission.

Read [field support](/providers/field-support) before switching accounts, and [receipts and retries](/reliability) before adding recovery behavior. Configuration and local validation do not authenticate the account or prove delivery.
