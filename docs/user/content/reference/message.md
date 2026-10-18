---
title: Message reference
description: Message fields, input types and validation limits.
---

`EmailMessageInput` is the encoded caller input. `parseEmailMessage` decodes it into an owned `EmailMessage` or fails with `EmailInvalidMessage`. It does not run provider preflight.

| Field                  | Input and constraint                                               |
| ---------------------- | ------------------------------------------------------------------ |
| `from`                 | One mailbox                                                        |
| `to`                   | One mailbox or a statically nonempty recipient array               |
| `subject`              | Nonempty string, at most 998 characters; no CR, LF or NUL          |
| `body`                 | Nonempty `text`, `html`, or both; each representation is bounded   |
| `cc`, `bcc`, `replyTo` | Optional nonempty recipient input                                  |
| `headers`              | Optional nonempty array of custom `{ name, value }` entries        |
| `tags`                 | Optional nonempty array of distinct-name `{ name, value }` entries |
| `metadata`             | Optional bounded string-to-string record                           |
| `attachments`          | Optional nonempty array of canonical attachment inputs             |
| `sendAt`               | Optional absolute scheduled instant                                |

The common message permits at most 50 total `to`/`cc`/`bcc` recipients. Provider rules can be stricter, including one-recipient or distinct-recipient requirements. Unknown excess fields are refused rather than silently discarded.

## Mailboxes

Use a conservative ASCII address, `{ address, name? }`, or one bounded named mailbox string. Internationalized local parts and arbitrary RFC list syntax are unsupported. `formatEmailMailbox` formats an already decoded mailbox; it does not establish provider support.

## Headers, tags and metadata

Headers cannot replace routing, authentication or MIME control fields. Names are bounded ASCII tokens and values exclude controls. Providers can further restrict names and repeated-name behavior.

Common tags require distinct names; provider tag count, alphabet and label formatting still apply. Common metadata permits bounded strings rather than nested JSON. Private `executionMetadata` belongs to [operation options](/reference/options), not this provider-facing field.

## Ownership and richer inputs

Decoding owns nested message values so later caller mutation cannot change the prepared message and options. Read [attachments](/reference/attachments) for byte and MIME selection, and [scheduling](/guides/scheduling) for accepted instant forms and dispatch-time checks. The [construction example](/messages) demonstrates ordinary inputs without caller casts.
