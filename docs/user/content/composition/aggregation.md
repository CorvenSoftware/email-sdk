---
title: Aggregate account observations and capture
description: Query named existing views across routed accounts without confusing their units or creating a global history.
---

Use named aggregates when your application needs one read surface over several existing account views. They sample configured observation/capture stores; they do not submit messages or create durable history.

## Aggregate minimal observations

<include lang="ts">/_examples/observation-aggregate.ts.template</include>

`observedEmailRouterLayer` keeps named account views available through `EmailObservationAggregate`. Each source identifies its unit: `SenderInvocation` or `NativeOperation`. Retained counts and truncation describe the samples, not lifetime sends or deliveries.

## Aggregate private capture

<include lang="ts">/_examples/capture-aggregate.ts.template</include>

`capturedEmailRouterLayer` supplies `EmailCaptureAggregate` over authorized capture views. Read `retainedRecords`, `retainedBytes`, source snapshots and `truncated`; keep payloads private.

## Keep acquisition and failure semantics

Reuse the same Layer values used by sending so queries observe the same acquired stores. Source names must be distinct bounded identifiers, not private account values. Aggregation returns its exported aggregate error if a sample cannot be read or validated.

Samples across sources are not globally atomic. Missing data, eviction or a closed view does not prove non-submission and must not reset route/key recovery evidence.
