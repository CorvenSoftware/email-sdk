---
title: SMTP
description: Send MIME email over explicit TLS SMTP with protocol-level recipient outcomes.
---

Import `smtpEmailLayer` from `@corven/email-sdk/smtp` to provide the common `Email` service for this account.

## Configure the account

<include lang="ts">/_examples/provider-smtp.ts.template</include>

SMTP manages its own explicit socket/TLS transport; it does not need an HTTP client.

## Message behavior

- Configure an explicit host, port, helloName and ImplicitTls or StartTls security mode. Plain and Login authentication require Redacted credentials; None is also explicit.
- Connecting to an IP requires an explicit certificate serverName. The adapter does not support an unencrypted SMTP mode.
- Attachments use explicit MIME types; inline CIDs must be qualified. Repeated custom headers are supported, but metadata, tags and provider scheduling are not.
- RCPT and DATA evidence can produce partial recipient outcomes. A final acknowledgment is not inbox delivery, and a lost DATA acknowledgment can leave the outcome unknown.

## Idempotency

SMTP has no native send key support in this SDK. Reopening a connection cannot prove that a previous transaction was not accepted.

Read [field support](/providers/field-support) before switching accounts, and [receipts and retries](/reliability) before adding recovery behavior. Configuration and local validation do not authenticate the account or prove delivery.
