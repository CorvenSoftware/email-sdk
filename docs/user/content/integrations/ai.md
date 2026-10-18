---
title: Add an AI email tool
description: Expose a Standard Schema tool backed by the scoped host-approved EmailAgent service.
---

`emailAiTool` from `@corven/email-sdk/ai` creates an Effect requiring `EmailAgent` and `Scope`. It does not acquire a model client or provider account.

<include lang="ts">/_examples/ai.ts.template</include>

Compose the [host-approved agent Layer](/integrations/agent) and keep the tool's owning scope open until all executions finish. Do not return a tool from a scope that is immediately closed.

## Runner contract

Supply an `EmailAiRunner` that runs the provided Effect and forwards its abort signal. The runner returns a Promise-like result. Propagate failures and cancellation. Do not report an unknown outcome as success or retry it in the runner.

The tool exposes `description`, `inputSchema`, `outputSchema` and `execute`. Declarations use Standard Schema and Standard JSON Schema rather than importing an AI SDK. Check your exact framework version in the consuming application; successful runtime execution does not prove framework-native type compatibility.

## Results and privacy

Output contains the receipt kind. It does not report delivery. `EmailAiToolError` reports `defect` or `not-completed` without exposing private original failures. A failed/interrupted call is not permission to resend.

Framework conversation histories and telemetry can retain proposed recipients and content. Apply application privacy controls and keep secrets out of model context. Host approval remains mandatory even if the framework displays its own confirmation UI.
