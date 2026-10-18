---
title: Receipt reference
description: Preserve exact receipt tags, correlation fields, recipient partitions and synthetic outcomes.
---

Narrow `EmailReceipt` with `_tag` or exhaustive Schema dispatch. Preserve the complete value; success is not a universal delivered status.

| `_tag`                    | Principal fields                                                       |
| ------------------------- | ---------------------------------------------------------------------- |
| `Accepted`                | `provider`, optional `messageId`, optional `submissionId`              |
| `AcceptedWithIds`         | `provider`, nonempty `messageIds`                                      |
| `PartiallyAccepted`       | `provider`, nonempty `accepted` and `suppressed`, optional `messageId` |
| `PartiallyRejected`       | `provider`, nonempty `accepted` and `rejected`                         |
| `PartiallyAcceptedCounts` | `provider`, accepted/rejected `counts`, optional `messageId`           |
| `RecipientOutcomes`       | `provider`, nonempty `outcomes`, optional `messageId`                  |
| `RecipientsRejected`      | `provider`, nonempty `rejected`, optional `messageId`                  |
| `Suppressed`              | `provider`, nonempty `suppressed`                                      |
| `Recorded`                | Local recording `sequence`                                             |
| `Simulated`               | `provider`, optional `messageId`                                       |

`EmailRecipientOutcome` has Accepted and Rejected cases with explicit recipient identity. An accepted outcome has a message ID; a rejected outcome may have one. Count-only evidence has no implied recipient mapping.

## Correlation and delivery

Message IDs, arrays of IDs and native submission IDs identify different provider handles. Their presence or order does not prove delivery, duplicate prevention or independent outcomes for a grouped request. Native jobs can acknowledge without a message ID.

`EmailRoutedReceipt` adds the actual `route` to the receipt family. Store that route in recovery state and use it when resuming the operation.

## Terminal outcomes

Partial, suppressed, rejected-recipient, simulated and recorded receipts do not authorize fallback or another send. Synthetic recording is not live submission. For error recovery, use [receipts and retries](/reliability), not a conversion of these variants to boolean success/failure.
