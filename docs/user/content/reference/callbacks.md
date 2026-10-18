---
title: Extension callbacks
description: Acquire callback dependencies once and distinguish retry restrictions from observations and message preparation.
---

`EmailExtension<Callback, E, R>` accepts a callback directly or an Effect that acquires it. Acquire callback dependencies in the Layer scope. Provide all service dependencies before invoking the callback. Acquiring a callback does not change the configured submission policy.

## Retry callbacks

<include lang="ts">/_examples/retry-callbacks.ts.template</include>

Provide the HTTP Layer before running this account. The optional callback arguments come after provider configuration and delivery policy.

| Callback                | Input                 | Result                                                       |
| ----------------------- | --------------------- | ------------------------------------------------------------ |
| `EmailRetryRestriction` | `EmailRetryCandidate` | Effect of boolean; false vetoes an otherwise eligible retry  |
| `EmailRetryObserver`    | `EmailRetryDecision`  | Effect of void, awaited after an eligible retry is permitted |

Candidates have RejectedRetryCandidate or UnknownRetryCandidate tags. Decisions have RejectedRetry or UnknownRetry tags. Both carry provider, current/next attempt, delay and safe reason. A restriction can reject an eligible retry. It cannot enable a retry that the provider or policy does not support. An observer receives the retry decision and cannot change it.

## Other callback boundaries

- [Transforms](/composition/transformations) return replacement message input.
- [Submission observers](/composition/observations) receive minimal starting/settled sender facts.
- [Operation observers](/composition/operations) receive complete private prepared-operation outcomes.
- [Native observers](/composition/native-instrumentation) describe Loops/Iterable jobs rather than common sender invocations.

All are trusted host Effects. Failures and interruption cannot roll back acknowledgment, become an ordinary retryable send error or authorize fallback. Keep private values out of diagnostic callback destinations and use explicit capture when payload retention is required.
