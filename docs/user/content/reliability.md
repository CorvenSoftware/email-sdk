---
title: Receipts, errors and retries
description: Interpret submission outcomes and choose retry or fallback behavior without duplicating an email.
---

A successful send returns an `EmailReceipt`. Inspect `_tag` to determine the submission result. An accepted receipt confirms that the provider acknowledged the request. It does not confirm that the recipient received the email.

Store definite rejections and unknown outcomes as separate application states. Use the stored state when deciding whether to retry.

## Interpret receipts

| Receipt `_tag`                            | Meaning                                                                                        |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `Accepted` / `AcceptedWithIds`            | The provider acknowledged the request. Correlation IDs may be absent, singular or multiple.    |
| `PartiallyAccepted` / `PartiallyRejected` | The provider reported accepted and suppressed or rejected recipient partitions. Preserve both. |
| `PartiallyAcceptedCounts`                 | The provider reported counts without identifying the recipients in each group.                 |
| `RecipientOutcomes`                       | The receipt contains explicit per-recipient results.                                           |
| `Suppressed`                              | The provider reported suppression. Do not bypass it through another account.                   |
| `RecipientsRejected`                      | The provider reported terminal rejection for the listed recipients.                            |
| `Recorded`                                | An in-memory recorder captured the message without contacting a provider.                      |
| `Simulated`                               | A provider sandbox acknowledged the request; this is not a live accepted submission.           |

A grouped request can include a `submissionId`. This identifies the request, not an individual message. Use explicit recipient results when available. Do not infer recipient results from counts or ID order. Message and submission IDs do not enable idempotent retries.

## Handle expected errors

| Error                                         | Response                                                                                                |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `EmailInvalidMessage` / `EmailInvalidOptions` | Correct the local input before trying again.                                                            |
| `EmailConfigurationError`                     | Correct Layer configuration; this error can occur before a service is acquired.                         |
| `EmailRejected`                               | Inspect the reason. Only eligible definite rejections permit retry or fallback; conflicts are terminal. |
| `EmailDeliveryUnknown`                        | Persist the uncertainty. Do not report the message as unsent or switch accounts to resend it.           |

Handle these tagged errors through Effect's expected-error channel. Defects and interruption remain Effect causes; they are not ordinary send errors or settled batch results. SDK diagnostics provide safe categories and paths. Keep original causes, provider payloads and private message inputs out of logs.

## Configure retries

Set a delivery policy on the provider Layer, or supply a complete policy override in send options. The policy sets attempt limits and deadlines. The SDK also checks whether the provider supports the requested retry.

Replaying an unknown outcome requires all of the following:

- Provider-supported idempotency for the selected account and operation.
- The same idempotency key and unchanged prepared message.
- A key within the provider's retention window and a policy that permits the retry.

Store each key with its application event and creation time. Key forwarding alone does not enable retries after an unknown outcome. If an earlier attempt has an unknown outcome, retain that state after a later rejection. Do not retry because an observer failed.

## Recover from timeouts and process loss

A timeout interrupts SDK-owned work but cannot recall a request the provider already accepted. Preserve uncertainty and reconcile through an application-owned process when the outcome cannot be established.

The SDK does not provide a durable queue or exactly-once delivery. Your application must retain recovery state and any route selected across restarts. See [account routing](./batching-routing#route-explicit-accounts) before adding fallback; restarting from a different account can duplicate the same logical email.
