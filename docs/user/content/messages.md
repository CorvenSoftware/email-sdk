---
title: Messages and attachments
description: Define addresses, message bodies, attachments and schedules with validated TypeScript inputs.
---

A message requires `from`, `to`, `subject` and `body`. The body must contain nonempty `text`, `html`, or both. Optional fields include `cc`, `bcc`, `replyTo`, headers, tags, metadata, attachments and `sendAt`.

The common Schema validates message structure. The selected provider must also support every supplied field; see [providers and validation](./providers).

## Build a message

`parseEmailMessage` validates common input and creates an owned message: subsequent changes to caller-supplied objects do not change the decoded message. It does not acquire a sender or run provider-specific checks.

<include lang="ts">./_examples/messages.ts.template</include>

Pass the result through `email.validate` or a provider preflight function to check provider support before submission.

## Specify addresses

Mailbox inputs accept:

- A conservative ASCII address, such as `recipient@example.test`.
- A structured record with `address` and optional `name`.
- A single named mailbox string, such as `Example Customer <recipient@example.test>`.

Recipient fields accept one mailbox or a statically nonempty array. Unicode display names are supported, but internationalized mailbox local parts and unrestricted RFC address-list syntax are not.

## Add attachments

Use `emailAttachmentFromBytes`, `emailAttachmentFromArrayBuffer` or `emailAttachmentFromBlob` to construct a bounded attachment from bytes your application has already acquired. These helpers do not read file paths, fetch URLs or infer MIME types from filenames or `Blob.type`.

Choose an explicit MIME type where the provider supports it. Select `ProviderSelected` only when you intend to delegate MIME selection to a compatible provider. Inline/CID placement also requires provider support.

Your application owns file or URL acquisition, content inspection, consent and retention. Attachment byte limits do not guarantee acceptance under the provider's encoded message-size limit. Interrupting a Blob read stops awaiting its result; it cannot guarantee physical cancellation of the native read.

## Schedule submission

`sendAt` accepts a native `Date`, an Effect UTC instant, or a strict timestamp containing seconds and a known UTC offset. Decoding preserves one UTC instant and rejects malformed dates, ambiguous offsets or unsupported precision.

A parsed schedule is not a provider reservation. Providers may restrict the allowed time window or require whole-second precision. Dispatch can recheck time-sensitive constraints after preparation or queueing, so allow enough lead time and handle expired schedules explicitly.

## Separate provider metadata from host context

Use `message.metadata` for provider-facing data when the provider supports it.

Use `options.executionMetadata` for bounded private application context needed during preparation, approval or complete operation observation. The SDK does not automatically forward this context to providers, models or minimal observations. It is not a template-variable source, credential store or replay token.
