---
title: Choose a sending mode
description: Select individual sends, batches, personalization, scheduled intent or native template jobs.
---

Choose the operation that describes your application intent, then check that the configured provider can preserve it.

| Intent                              | Operation                      | Submission unit                                                            |
| ----------------------------------- | ------------------------------ | -------------------------------------------------------------------------- |
| One literal message                 | `Email.send`                   | One prepared message                                                       |
| Independent messages                | `Email.sendAll`                | One item per request envelope                                              |
| One template with an audience       | `Email.sendPersonalized`       | Individual messages by default; a native request only with an opt-in Layer |
| Provider-managed published template | `LoopsTransactionalEmail.send` | One native template job                                                    |
| Provider-managed triggered campaign | `IterableCampaignEmail.send`   | One native campaign job                                                    |

## Batches and personalization

Batch Results retain input order. Concurrency controls dispatch, not atomicity: a later failure cannot undo an already accepted item. Every independent logical message needs its own key when the provider supports keys.

`Individual` personalization expands the application template before dispatch. `NativeAudience` shares a provider request and its acknowledgment. Native execution is not an automatic optimization; wrappers and routing can refuse it. See [personalization](/guides/personalization).

## Scheduling

`sendAt` describes a provider schedule where supported. The SDK does not run a durable background scheduler or persist future work. For an application-owned schedule, retain the job and dispatch it from your worker at the intended time. See [scheduling](/guides/scheduling).

## Review before sending

Use `Email.prepare` when the effective message must be reviewed after defaults, transformations or routing. Dispatch that same prepared operation instead of constructing a new message after approval. See [preparation](/composition#prepare-a-message-for-review).
