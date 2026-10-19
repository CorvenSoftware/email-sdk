---
title: Private submission capture
description: Capture bounded private request/outcome payloads with explicit permission and retention controls.
---

Use `capturedEmailSenderLayer` from `@corvencore/email-sdk/capture` only when your application is authorized to retain message payloads:

<include lang="ts">/_examples/capture.ts.template</include>

The example uses a recorder, so it does not contact a provider. In production, substitute the configured sender without changing the capture/query ownership.

## Configure retention

Supply `capacity`, `maxBytes` and `privateData: "AuthorizePayloadCapture"`. Retention is bounded by record count and UTF-8 bytes. Oversized or evicted data is reflected in `truncated`; the view is not a complete audit log.

`EmailSubmissionCapture.snapshot` returns `records`, `retainedBytes`, `closed` and `truncated`. Each record's `payloadJson` is Redacted. Unwrap and decode it only in an explicitly authorized private path using the exported payload Schema; do not log it as a diagnostic shortcut.

## Purge the visible view

`purgeRecords` removes visible records and returns the count removed. It does not securely erase copies already returned to callers, clear every private application store or reset duplicate-prevention evidence.

Keep sending and querying in the same Layer acquisition. Define access control and retention outside the SDK before replacing the synthetic sender with a real account. Use [minimal observations](/composition/observations) when payloads are unnecessary.
