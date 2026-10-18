---
title: Prepared-operation observations
description: Observe effective previews, private context and complete logical outcomes around an Email operation.
---

Use root `observedEmailOperationLayer` when a sender-call summary is insufficient for application review or auditing:

<include lang="ts">/_examples/operation-observations.ts.template</include>

The callback is an `EmailOperationObserver`. It sees the effective operation at this wrapper boundary, including private previews/context and its modeled outcome. Choose wrapper order deliberately: an observer outside defaults sees a different preparation boundary from an observer inside them.

## Preserve the prepared operation

Call `prepare`, review the resulting previews and use its validation/send Effects within the same live scope. Do not rebuild the operation after review. Observing does not add permission to alter keys, routes or delivery policy.

## Handle callback failure

Callbacks are awaited host Effects and may fail unexpectedly. Their failure cannot make an acknowledged submission unsent or turn uncertainty into replay permission. Preserve defects and interruption instead of selecting an ordinary typed send failure from a compound cause.

Complete operation events expose private application data by design. Apply access and retention controls to callback destinations. For bounded payload storage, use [capture](/composition/capture); for minimal status-only facts, use [submission observations](/composition/observations).
