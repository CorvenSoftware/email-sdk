---
title: Native job observations and capture
description: Inspect Loops and Iterable operations through their own minimal or private instrumentation boundaries.
---

Use native instrumentation for `LoopsTransactionalEmail` and `IterableCampaignEmail`. Common sender-call wrappers do not describe these specialized service operations.

## Minimal operation facts

<include lang="ts">/_examples/native-observations.ts.template</include>

`observedLoopsTransactionalLayer` supplies `EmailNativeObservations`; the Iterable counterpart wraps campaign operations. A snapshot retains bounded `Receipt`, `Rejected` and `Unknown` facts with the native operation kind. The lazy example sends the supplied job through an explicitly supplied account before reading its view; validation alone does not record an operation.

## Authorized private capture

<include lang="ts">/_examples/native-capture.ts.template</include>

`capturedLoopsTransactionalLayer` and `capturedIterableCampaignLayer` require count/byte bounds and `AuthorizePayloadCapture`. `EmailNativeCapture` exposes a Redacted payload view plus `purgeRecords`. Decode with `EmailNativeCapturePayloadSchema` only in an authorized private path.

Supply an authorized configured account and its HTTP transport before running these programs; constructing their Effects does not send. Keep views and sending in the same acquisition. Callback failure cannot undo acknowledgment, truncation does not prove non-submission, and purging is not secure erasure of escaped data or permission to repeat a job.
