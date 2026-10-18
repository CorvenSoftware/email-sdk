---
title: Send options and delivery policy
description: Define keys, complete policy overrides, execution metadata and bounded batch concurrency.
---

`EmailSendOptionsInput` contains optional `idempotencyKey`, `policy` and `executionMetadata`. Options are separate from provider-facing message fields.

## Delivery policy

<include lang="ts">/_examples/delivery-policy.ts.template</include>

A policy is a complete object, not a partial merge:

| Field          | Meaning                                     | Constraint                      |
| -------------- | ------------------------------------------- | ------------------------------- |
| `deadline`     | Total owned submission/retry budget         | Positive finite Effect Duration |
| `initialDelay` | Initial retry backoff                       | Positive finite Effect Duration |
| `maxAttempts`  | Total allowed attempts, including the first | Integer from 1 through 6        |

The built-in default is a 30-second deadline, 100-millisecond initial delay and three attempts. Provider convenience Layers accept a policy; an ordinary operation's complete override replaces it. Retries use exponential jittered delay and supported provider delay hints, subject to evidence and authority limits.

Setting `maxAttempts: 1` does not guarantee non-submission after timeout. A native replay policy with multiple attempts must fit inside the provider retention window. See [idempotency](/concepts/idempotency).

## Keys and execution context

`idempotencyKey` must satisfy the common bounded alphabet and the provider's narrower requirements. Unsupported keys fail before transport. Keys do not transfer across accounts.

`executionMetadata` is bounded private host context for preparation, approval and complete operation observation. It is not automatically provider metadata or model input.

## Batch and personalized options

`sendAll` envelopes each contain `{ message, options? }`; shared batch options contain `concurrency`, bounded from 1 through 32. Personalization options may contain concurrency and execution context; keys belong to individual audience entries. A native job batch uses `{ job, options? }` instead of a literal-message envelope.

Expected option decoding fails with `EmailInvalidOptions`. Defects and interruption are never ordinary invalid-option errors.
