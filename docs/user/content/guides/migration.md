---
title: Migrate an existing notification workflow
description: Move provider-specific application code behind Email while preserving fields, failures and account identity.
---

Migrate one workflow and one account at a time. Corven is an Effect-native redesign, not a source-compatible replacement for another email SDK or Nodemailer.

## List the current message fields

Record sender and recipient rules, body formats, attachments, headers, metadata, schedules, tracking, automatic copies and any provider-managed rendering. Preserve existing consent and suppression behavior.

Compare that intent with the [provider guide](/providers) and [field-support table](/providers/field-support). A familiar provider name does not mean every upstream SDK option is implemented.

## Configure the Email Layer

Keep notification code dependent on `Email`; provide the selected provider account and safe transport in the host. Start with an offline [recording Layer](/guides/testing) to compare caller-visible messages without submitting them.

Translate input into the [common message model](/reference/message). For SMTP, supply explicit TLS and authentication settings instead of a Nodemailer transporter. For Loops or Iterable, use the native job service rather than forcing provider templates into a literal-message envelope.

## Translate outcomes, not just method names

Replace boolean sent flags with the receipt union and explicit unknown state. Preserve partial results and recipient evidence. Remove transport-level automatic retries before enabling SDK policy.

Do not carry a key to a provider that rejects keys, or move a previously attempted event to another account on restart. Review existing queue/recovery behavior against [idempotency](/concepts/idempotency).

## Switch only after application checks

Compile against the installed package, test the same application program with recording and controlled failures, and review the configured account attestations. Real authentication, acceptance and delivery remain separate operational checks; compiled examples do not establish them.
