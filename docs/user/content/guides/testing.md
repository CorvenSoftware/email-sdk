---
title: Test email workflows
description: Test recorded intent and controlled failures without contacting a provider.
---

Replace the provider Layer where your application provides Layers. Keep the notification program unchanged so tests exercise the same `Email` calls as production.

## Inspect recorded messages

Use `recordingEmailLayer` and acquire `RecordedEmails` in the same scope, as in the [quickstart](/quickstart). Inspect the returned messages and receipt. Assert the expected recipient, rendered content or absence of a submission after a refused action.

A recorder is in-memory simulation. Reacquisition creates a separate store; purging visible records is not a durable duplicate-prevention mechanism.

## Simulate uncertainty

<include lang="ts">/_examples/failing-workflow.ts.template</include>

`failingEmailLayer` exposes `FailedEmailSubmissions` and a controlled expected error. This sender does not support idempotent retries after an unknown outcome. The program records one attempt even though its policy permits up to three.

Use this result to test your application's pending/reconciliation state. Do not convert it to an unsent flag or route it automatically to a backup. To exercise eligible rejection behavior instead, supply an `EmailRejected` with the appropriate reason and explicit policy.

## Choose meaningful assertions

Test observable messages, results, route choices and side effects through public services. Avoid factory-count assertions, copied constants and snapshots whose only purpose is to detect edits. Add a regression case only when it fills a genuine behavior gap.

For time and ordering tests, use the Effect test clock and explicit coordination rather than sleeps. Separate application simulation from loopback protocol tests and [live provider evidence](/providers/verification).
