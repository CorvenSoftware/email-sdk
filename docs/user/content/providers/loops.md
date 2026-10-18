---
title: Loops transactional templates
description: Configure a Loops account and send a job that uses a published transactional template.
---

Use `LoopsTransactionalEmail` from `@corven/email-sdk/loops`. This is a native published-template service, not a literal-message `Email` Layer or ordinary routing target.

<include lang="ts">/_examples/loops.ts.template</include>

## Configure the template

Supply `apiKey`, `templateAuthority: "ProviderManaged"` and an attachment policy of Disabled or AccountEnabled. These options authorize provider-owned content and describe known account prerequisites; the SDK does not publish or inspect a template.

## Build a job

`send` takes `transactionalId`, one plain `email` recipient and optional `dataVariables`/attachments. Variables support bounded strings, finite numbers and bounded nonempty arrays of flat records. Arbitrary nested application JSON and booleans are not interchangeable with this input contract.

Attachments require explicit MIME types, no inline CID placement and account enablement. Common sender/subject/body fields are not a native template job.

`validate` returns an owned job without sending. `sendAll` takes `{ job, options? }` envelopes, returning ordered per-item Results with bounded concurrency. Defects and interruption still propagate.

## Handle acknowledgment and keys

An accepted Loops receipt can omit the provider message ID. Store the receipt without adding an ID. The service forwards keys of up to 100 characters and declares `KeyForwarding`. The SDK does not retry requests with unknown submission outcomes.

For shared variables or instrumentation, use [native defaults](/composition/native-defaults) and [native observations/capture](/composition/native-instrumentation).
