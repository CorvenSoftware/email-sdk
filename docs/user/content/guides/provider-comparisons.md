---
title: Compare providers for a workflow
description: Compare provider field support, idempotency and required account settings.
---

Choose a provider using the message and recovery behavior your application needs. Pricing, account entitlements and remote service capabilities change independently of the SDK; this guide compares implemented local contracts, not current subscription offers.

## Resend and Postmark

[Resend](/providers/resend) supports scheduling and native scoped keys, but not common metadata. [Postmark](/providers/postmark) supports metadata and repeated headers, but rejects scheduling and send keys. A keyed Resend workflow is therefore not a drop-in Postmark fallback.

## SendGrid and Mailgun

Both support rich ordinary messages and opt-in native personalization. [SendGrid](/providers/sendgrid) uses unique headers and a regional JSON protocol; [Mailgun](/providers/mailgun) preserves repeated headers and uses a domain-scoped multipart protocol. Their scheduling precision, tag rules and inline attachment constraints differ. Neither adapter declares native send replay authority.

## SES and Microsoft Graph

[SES](/providers/ses) uses explicit regional signing credentials and supports bounded ASCII tags. [Graph](/providers/graph) uses a host-acquired access token and mailbox identity, with one representable body format and no common tag support. Both require reviewed mail-flow authority and provide no send key support here.

## Loops and literal-message providers

[Loops](/providers/loops) runs a provider-managed published template. It is not a substitute account for a literal-message route. Compare native content/profile behavior and ownership before deciding that two methods named `send` represent the same operation.

## SMTP and HTTP providers

[SMTP](/providers/smtp) supplies its own explicit TLS transport and protocol-level recipient evidence. HTTP providers require a host HTTP client and provider-specific acknowledgment classification. Neither transport family automatically proves delivery or safe replay.

Before routing between any pair, check [field support](/providers/field-support), then preflight every selected candidate's effective message, key and policy. A compatible message format alone is insufficient for fallback authority.
