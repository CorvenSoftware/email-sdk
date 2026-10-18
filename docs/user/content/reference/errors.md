---
title: Error reference
description: Inspect expected SDK error tags and safe fields without treating uncertainty, defects or interruption as non-submission.
---

Errors use Schema-tagged classes. `EmailSendError` is the union of invalid message, invalid options and submission errors; `EmailSubmissionError` contains `EmailRejected` and `EmailDeliveryUnknown`. Configuration can fail before a service is acquired.

## Common failures

| Error                     | Safe fields                                                                 | Meaning                                              |
| ------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------- |
| `EmailInvalidMessage`     | `issues`                                                                    | Common or provider-local message refusal             |
| `EmailInvalidOptions`     | `issues`                                                                    | Invalid keys, policies, routing or operation options |
| `EmailConfigurationError` | `issues`                                                                    | Invalid Layer configuration or composition           |
| `EmailRejected`           | `provider`, `reason`, optional `status`, `providerCode`, `retryAfterMillis` | Definite rejection evidence                          |
| `EmailDeliveryUnknown`    | Same contextual fields and its own `reason` union                           | Submission outcome could not be established          |

Issue entries contain safe `path` and `problem` descriptions, not private input values or original parser/provider errors.

### Rejection reasons

Reasons are `authentication`, `rate-limited`, `temporarily-unavailable`, `invalid-message`, `idempotency-conflict`, `unsupported-idempotency` and `rejected`. Not every definite rejection permits retry or fallback. Conflicts remain terminal; a later rejection cannot erase an earlier unknown attempt.

### Unknown reasons

Reasons are `transport`, `timeout`, `invalid-response`, `server-error`, `unexpected-status` and `idempotency-in-progress`. Retain uncertainty. A retry requires provider-supported idempotency for the selected account, the same key and prepared message, and a policy and error reason that permit it.

## Integration failures

| Error                            | Reasons or boundary                                                   |
| -------------------------------- | --------------------------------------------------------------------- |
| `EmailRenderError`               | `invalid-template`, `render-failed`, `invalid-output`                 |
| `EmailAgentApprovalError`        | `declined`, `unavailable`                                             |
| `EmailAiToolError`               | `defect`, `not-completed`; no assumption of non-submission            |
| `EmailWebhookVerificationError`  | `invalid-request`, `timestamp-outside-tolerance`, `invalid-signature` |
| `EmailWebhookNormalizationError` | `invalid-json`, `invalid-payload`, `payload-limit`                    |
| Aggregate errors                 | An observation or capture sample could not be read or validated       |

Import integration errors from their corresponding public entrypoint. The executable CLI reports its own safe error reason and [exit code](/reference/cli), not a private thrown provider exception.

## Preserve causes

Defects and interruption remain Effect causes. They cannot be converted into an ordinary settled batch failure or selected away from a compound cause to make replay seem eligible. Follow the [troubleshooting guide](/guides/troubleshooting) for application recovery.
