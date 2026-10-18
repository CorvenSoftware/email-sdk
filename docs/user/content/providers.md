---
title: Choose a provider
description: Configure an existing provider account, compare supported intent and distinguish ordinary email from native jobs.
---

Choose the provider whose account your application already owns, then check that it can preserve the complete message and recovery policy. Changing Layers keeps the common `Email` interface; it does not make provider features interchangeable.

Start with [field support](/providers/field-support), [local preflight](/providers/capabilities) and [verification boundaries](/providers/verification). Each guide below includes a configured Layer example, message constraints and replay limits.

## Ordinary email Layers

| Provider                                          | Configuration focus                                          |
| ------------------------------------------------- | ------------------------------------------------------------ |
| [Resend](/providers/resend)                       | Native scoped keys and scheduling                            |
| [Postmark](/providers/postmark)                   | Message streams, repeated headers and metadata               |
| [SendGrid](/providers/sendgrid)                   | Regional Mail Send and opt-in native personalization         |
| [Mailgun](/providers/mailgun)                     | Domain-scoped multipart messages and repeated headers        |
| [MailerSend](/providers/mailersend)               | Provider-selected attachment MIME and suppression evidence   |
| [MailPace](/providers/mailpace)                   | Supported headers, attachment extensions and tags            |
| [Unosend](/providers/unosend)                     | Explicit attachment MIME and scheduling                      |
| [Lettermint](/providers/lettermint)               | Provider routes, native keys and sandbox-aware receipts      |
| [Plunk](/providers/plunk)                         | Contact upserts and provider-generated text                  |
| [Helo](/providers/helo)                           | Live/sandbox channels and short-lived native replay          |
| [JetEmail](/providers/jetemail)                   | Transactional tokens, domain attestations and forwarded keys |
| [Lettr](/providers/lettr)                         | Immediate/scheduled modes and count-only receipts            |
| [SparkPost](/providers/sparkpost)                 | Regional transmissions and count-aware acknowledgment        |
| [Primitive](/providers/primitive)                 | Explicit key requirements and content deduplication policy   |
| [Mailtrap](/providers/mailtrap)                   | Email Sending and multiple acknowledgment IDs                |
| [Mailchimp Transactional](/providers/mailchimp)   | Account behavior and per-recipient outcomes                  |
| [Scaleway](/providers/scaleway)                   | Project-bound transactional intent                           |
| [ZeptoMail](/providers/zeptomail)                 | Live or sandbox mail agents                                  |
| [Cloudflare Email Sending](/providers/cloudflare) | REST account transport and constrained mail flow             |
| [Amazon SES](/providers/ses)                      | Explicit regional SigV4 credentials                          |
| [Microsoft Graph](/providers/graph)               | Host-acquired access token and mailbox identity              |
| [SMTP](/providers/smtp)                           | Explicit TLS transport and protocol recipient evidence       |
| [Brevo](/providers/brevo)                         | Provider rendering and tracking authority                    |
| [Sequenzy](/providers/sequenzy)                   | Transactional HTML and provider-managed profiles             |
| [SendHeron](/providers/sendheron)                 | Attachment policy and configuration-dependent replay         |

## Native provider jobs

[Loops](/providers/loops) triggers a provider-managed published template. [Iterable](/providers/iterable) triggers a provider-managed campaign. These have separate service interfaces and native `{ job, options? }` batches. They are not ordinary `Email` Layers or fallback targets.

## Compose accounts safely

Use [named routing](/batching-routing#route-explicit-accounts) to bind explicit account Layers. Preflight every selected candidate without dropping fields. Only eligible definite rejection advances fallback; unknown or terminal outcomes stop the chain.

Opt-in SendGrid/Mailgun `NativeAudience` Layers share one provider request. Common individual-preparation wrappers and ordinary routing refuse that mode. See [personalization](/guides/personalization) before composing grouped sends.
