---
title: Message field support
description: Compare the SDK's declared provider profiles for headers, attachments, metadata, scheduling and tags.
---

Use this table to shortlist providers, then validate the complete message against the configured Layer. It describes the SDK's exported base capability profiles, not every feature advertised by the remote service. Additional provider rules can refuse an otherwise supported field.

| Provider                                          | Headers  | Attachment MIME selection | Inline | Metadata | Scheduling | Maximum tags |
| ------------------------------------------------- | -------- | ------------------------- | ------ | -------- | ---------- | ------------ |
| [Resend](/providers/resend)                       | Unique   | Both                      | Yes    | No       | Yes        | 75           |
| [Postmark](/providers/postmark)                   | Repeated | Explicit                  | Yes    | Yes      | No         | 1            |
| [SendGrid](/providers/sendgrid)                   | Unique   | Both                      | Yes    | Yes      | Yes        | 10           |
| [Mailgun](/providers/mailgun)                     | Repeated | Explicit                  | Yes    | Yes      | Yes        | 3            |
| [MailerSend](/providers/mailersend)               | Repeated | ProviderSelected          | Yes    | No       | Yes        | 5            |
| [MailPace](/providers/mailpace)                   | Unique   | Explicit                  | Yes    | No       | No         | 75           |
| [Unosend](/providers/unosend)                     | Unique   | Explicit                  | No     | No       | Yes        | 75           |
| [Lettermint](/providers/lettermint)               | Unique   | Both                      | Yes    | Yes      | Yes        | 20           |
| [Plunk](/providers/plunk)                         | Unique   | Explicit                  | Yes    | No       | No         | 0            |
| [Helo](/providers/helo)                           | Unique   | Both                      | Yes    | Yes      | No         | 5            |
| [JetEmail](/providers/jetemail)                   | Unique   | ProviderSelected          | No     | No       | Yes        | 0            |
| [Lettr](/providers/lettr)                         | Unique   | Explicit                  | No     | Yes      | No         | 1            |
| [SparkPost](/providers/sparkpost)                 | Unique   | Explicit                  | Yes    | Yes      | Yes        | 0            |
| [Primitive](/providers/primitive)                 | Unique   | Both                      | Yes    | No       | No         | 0            |
| [Mailtrap](/providers/mailtrap)                   | Unique   | Both                      | Yes    | Yes      | No         | 1            |
| [Mailchimp Transactional](/providers/mailchimp)   | Unique   | Explicit                  | Yes    | Yes      | Yes        | 0            |
| [Scaleway](/providers/scaleway)                   | Unique   | Explicit                  | No     | No       | No         | 0            |
| [ZeptoMail](/providers/zeptomail)                 | Unique   | Explicit                  | Yes    | No       | No         | 0            |
| [Cloudflare Email Sending](/providers/cloudflare) | Unique   | Explicit                  | Yes    | No       | No         | 0            |
| [Amazon SES](/providers/ses)                      | Unique   | Explicit                  | Yes    | No       | No         | 50           |
| [Microsoft Graph](/providers/graph)               | Unique   | Explicit                  | Yes    | No       | No         | 0            |
| [SMTP](/providers/smtp)                           | Repeated | Explicit                  | Yes    | No       | No         | 0            |
| [Brevo](/providers/brevo)                         | Unique   | ProviderSelected          | No     | No       | Yes        | 0            |
| [Sequenzy](/providers/sequenzy)                   | None     | Both                      | No     | No       | No         | 0            |
| [SendHeron](/providers/sendheron)                 | Unique   | Explicit                  | No     | No       | Yes        | 0            |

## Read the table

- `Unique` headers require distinct names ignoring case. `Repeated` preserves repeated names. A provider can additionally restrict which names are allowed.
- `Explicit` attachment MIME selection requires a concrete content type. `ProviderSelected` delegates selection. `Both` supports either choice, never silent conversion between them.
- A supported schedule still has provider-specific precision and time-window checks. Inline attachments can have additional CID or filename restrictions.
- Tag counts do not describe allowed label syntax. Metadata support does not imply that nested application objects can be sent.

## Account and mode differences

Lettr's base profile is Immediate; Scheduled mode enables scheduling and removes key support. Mailchimp's base profile disables tags; its explicit known-tag statistics configuration can enable a bounded subset. SendHeron's Disabled attachment mode removes attachment support and changes replay guarantees.

Use the acquired `email.capabilities` and `email.personalization` for the configured service. The table does not cover Loops or Iterable native jobs, and field support alone never grants [idempotent replay](/concepts/idempotency).
