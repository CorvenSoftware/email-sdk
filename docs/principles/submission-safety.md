# Submission safety

Read this when changing provider acknowledgement/error classification, retry or fallback policy, prepared approval, callbacks, retention, or webhook trust. A result reports evidence at one boundary; it does not grant authority at another.

## Classify evidence before recovery

For each new response or failure category, answer:

1. Does the provider evidence prove this attempt was not accepted, prove acknowledgement, or leave the outcome unknown?
2. Which provider/account/endpoint and unchanged intent does that evidence cover?
3. What existing policy permits another action? A hint, ID or observer exception is not permission.

| Evidence                                                          | Consequence                                                                                                                                                          |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Eligible definite rejection                                       | Existing policy may retry or advance an explicit route. Not every rejection is eligible.                                                                             |
| Unknown outcome                                                   | Stop fallback. Replay requires explicit native provider/account-local authority, a stable scoped key, unchanged owned intent and applicable retention/policy bounds. |
| Key forwarded without native authority                            | Preserve the key, but do not infer ambiguous replay permission.                                                                                                      |
| Terminal acknowledgement, conflict, partial or suppressed outcome | Preserve the complete outcome; do not turn it into a reason to try another provider.                                                                                 |
| Timeout or interruption                                           | Cancellation cannot prove that the provider did not accept work. Preserve uncertainty or interruption rather than reporting non-submission.                          |

Inspect the current predicates in [submission policy](../../src/email-submission-policy.ts) and [routing](../../src/email-routing.ts) when changing eligibility; do not copy an error-code allowlist into this document. A later ordinary rejection cannot erase an earlier unknown attempt. A native key conflict remains terminal, not reconstructed acceptance or proof of earlier non-acceptance.

Key age across separate executions, durable route selection and process loss are application concerns. An in-memory recording Layer is not cross-account or durable deduplication. Eviction or purging an observation view must not reset replay/conflict evidence; deleting a visible record is not secure erasure of canonical data or escaped snapshots.

## Own intent before external work

Preflight every routed candidate's effective message, key and policy before transport. Reject unsupported fields rather than dropping them. Recheck time-sensitive constraints without moving or rounding expired intent into a different request. Complete batch preparation is not atomic submission; cancellation cannot undo an item already accepted.

Defaults, transformations and host approval must refer to the same owned prepared operation. Recomputing a transformation after approval can produce unreviewed intent. Model input, framework tool approval flags and generated tool-call IDs are not host account/key/approval authority. Inspect [the agent boundary](../../src/email-agent.ts) when changing this sequence.

## Callbacks and failure causes

Observers are host code, not additional submission authority. Their defects or interruption must not authorize retry, fallback or ordinary failed-item settlement. A callback after an acknowledged submission cannot roll it back. Keep starting notifications, sender invocations, logical operations and native grouped requests distinct; absence from one observation seam is not proof that nothing happened.

When changing typed recovery, inspect [protectEmailUnsettledCause](../../src/email-unsettled-cause.ts). Selecting one typed failure from a compound cause can discard accompanying defects/interruption and accidentally make it retryable. Preserve unexpected causes and normal result identity; diagnostics still exclude original private defects.

For callback ordering, cancellation and resource evidence, use the relevant branch of [testing principles](../contributing/testing-principles.md#own-time-ordering-and-resources).

## Keep proof scopes separate

- Outbound acknowledgement is not delivery, inbox placement or consent.
- Resend raw-body authentication is distinct from event projection; decoding an observation Schema does not authenticate serialized data.
- Mailgun's timestamp/token signature does not authenticate event-body content. Mailgun and Postmark event projections retain unverified payload provenance; account flags in an unsigned body are not tenant or routing proof.
- Endpoint acquisition, trusted ingress, tenant binding and durable replay storage remain application-owned. A fresh signature does not mean an event has not already been processed.

For an inbound change, inspect the affected verifier and event module together, then their public tests. For example, [Mailgun verification](../../src/mailgun-webhook-verifier.ts) and [event projection](../../src/mailgun-webhook-event.ts) deliberately have different inputs and authority. Preserve raw bytes, duplicate-field refusal and safe failure boundaries rather than inventing a universal verified-event type.

## Preserve privacy and permission

Credentials stay explicitly supplied and Redacted. SDK diagnostics/spans exclude message content, recipients, payloads, keys, original errors and private defects; use the existing [status-only tracing owner](../../src/email-tracing.ts). Supplied transports must not add hidden mutation retries, redirects or sensitive request logging beneath the SDK policy.

Local synthetic/loopback work is not live evidence. Before any real authentication probe, model/provider call or send, obtain affirmative approval for the exact source/command, destination, credential/data scope, effects/cost, control, stop conditions and cleanup. Expanded scope needs renewed approval. Missing credentials mean NOT CHECKED, not failure or permission to discover them.

Finish when the changed boundary preserves both its evidence and its authority limits, and public tests cover the genuine changed risks: unknown/no-replay/no-fallback, terminal outcomes, ownership, callback faults, cleanup or proof separation as applicable. Passing a local test never certifies delivery or a remote account setting.
