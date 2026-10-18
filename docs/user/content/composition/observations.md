---
title: Submission observations
description: Observe minimal starting and settled sender-call facts without capturing private payloads.
---

Use `observedEmailSenderLayer` from `@corven/email-sdk/observations` around an `EmailSender`, then build the common `Email` service:

<include lang="ts">/_examples/observations.ts.template</include>

`Layer.provideMerge` keeps the observation query service available alongside sending. Acquire both from the same composed Layer.

## Read the view

`EmailSubmissionObservations.snapshot` returns retained observations and `truncated`. Settled cases are `Receipt`, `Rejected` and `Unknown`. A receipt observation includes only its kind and provider; it does not retain recipients, message content, keys or original private causes.

The optional starting callback describes a sender invocation. It is a separate event from settled history, not evidence that the provider accepted a message.

## Choose the correct unit

A sender call is not necessarily a whole logical workflow, an audience or a lifetime delivery count. Local validation can fail before this observation boundary. For complete prepared-operation outcomes, use [operation observations](/composition/operations); for Loops/Iterable use [native instrumentation](/composition/native-instrumentation).

Callbacks are awaited Effects. A callback failure can stop the caller's workflow, but cannot roll back a provider acknowledgment or authorize retry/fallback. Treat missing data and truncated history as incomplete evidence.
