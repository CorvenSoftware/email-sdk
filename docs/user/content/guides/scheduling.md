---
title: Schedule an email
description: Choose provider scheduling or an application-owned worker and preserve the intended UTC instant.
---

Use `sendAt` when the selected provider supports scheduling and its time window fits your job. Use an application-owned scheduler when work must survive restarts, be dispatched outside that window or be controlled by your queue.

## Supply a future instant

<include lang="ts">/_examples/scheduling.ts.template</include>

Provide a compatible `Email` Layer before running the program. This example computes a future instant when the Effect executes. It does not reserve provider capacity or persist the schedule.

## Validate precision and lead time

The common input accepts a native `Date`, an Effect UTC instant or a strict timestamp with seconds and a known offset. Provider rules can require whole seconds, limit how far ahead the instant may be, or restrict scheduling to a configured mode.

The ten-minute example is not portable to every provider. Inspect [field support](/providers/field-support) and the selected provider page. Recheck close to dispatch and allow for preparation, latency and clock skew. Do not silently round, advance or drop an expired schedule.

## Own durable scheduling

For an application queue, retain message data, the logical event identity and the selected account. When the worker executes, prepare and validate the message again within its authorized policy. If you use provider scheduling, handle its acknowledgment as scheduled submission evidence, not completed delivery.

Cancellation of an SDK Effect is not cancellation of an already accepted remote schedule. This SDK does not expose a universal provider cancellation operation.
