---
title: Batching, personalization, and routing
description: Send batches, personalize messages, and configure named provider accounts.
---

Use `sendAll` for independent messages, `sendPersonalized` for a template and an audience, or `EmailRouter` for named accounts.

## Send a batch

Create an array of `{ message, options? }` request envelopes. Pass the array and a concurrency setting to `sendAll`:

<include lang="ts">./_examples/batching.ts.template</include>

Provide an `Email` Layer before you run the Effect. The [provider guide](./sending) and the offline [quickstart](./quickstart) show Layer setup.

If you set keys or delivery policies, configure them per request. Do not use one key for unrelated messages.

Read results in input order. Expected item failures appear as Effect Results. Defects and interruption propagate and cancel active work. Cancellation does not undo accepted submissions.

Do not treat the batch as an atomic transaction. `sendAll` does not select a provider-native bulk operation.

## Stream independent messages

Pass a Stream of request envelopes to `sendEmailStream`:

<include lang="ts">./_examples/streaming.ts.template</include>

Provide an `Email` Layer before you consume the Stream. Consume the Stream with an Effect Stream runner. Read each `{ index, result }` in source order. The index starts at zero for the complete source.

Set concurrency to limit active item submissions. Keep each item's key and policy separate.

The helper copies and prepares each request when it processes that request. Preparation includes all selected route candidates. Unlike `sendAll`, the helper does not prepare the complete source before sending. A sparse source does not wait for a full batch.

Persist outcomes as you consume them. Expected item failures appear as Results. Upstream failures, defects, and interruption stop the Stream. Stopping consumption interrupts active work but cannot undo accepted submissions. A failed Stream does not establish whether earlier or active submissions reached a provider.

## Personalize a message

Pass a template without recipient fields and an explicit audience to `sendPersonalized`. For each recipient, supply a mailbox, template variables, and an optional idempotency key.

Set concurrency and context through shared options. Do not use one idempotency key for the whole audience.

In `Individual` mode, the SDK expands the template into a message for each recipient. To preview expansion without a sender, use `renderEmailPersonalizedMessage`.

HTML expansion escapes text markup. It does not validate URL or CSS contexts or sanitize arbitrary HTML. Handle missing variables and invalid expanded messages as failures.

### Use native personalization

To submit a valid audience subset through one native request, use an opt-in SendGrid or Mailgun Layer. Recipients share request-level acknowledgment, a deadline, and correlation.

Check the configured `personalization` mode before composing Layers. Common defaults, transformation wrappers, and ordinary routing reject `NativeAudience` Layers. These operations do not convert a native audience into individual sends.

Do not assume independent wire requests or per-recipient acknowledgment from the method name.

## Route explicit accounts

Register a Layer for each named account with `emailRouterLayer`. Select a route through `EmailRouter`:

<include lang="ts">./_examples/routing.ts.template</include>

Use the HTTP Layer from [the provider guide](./sending#configure-transport-behavior). The example omits an idempotency key because Postmark does not support keys in this SDK.

Before adding a field or key, check support in every selected account, including fallbacks. The router preflights the effective message, options, and policy for every candidate before submission. Unsupported fallback intent causes a local failure.

For default-plan types and runtime validation, see the [routing reference](/reference/routing#route-plan).

### Explain a route plan without sending

To check a plan before sending:

1. Provide a Layer from `emailRouterLayer`.
2. Call `explainEmailRoutePlan(plan, request)` with an explicit plan and a `{ message, options? }` request envelope.
3. Run the returned Effect.

<include lang="ts">./_examples/route-explanation.ts.template</include>

Read `candidates` in plan order. Each candidate has a `Compatible` or `Incompatible` tag. An incompatible candidate includes its typed preparation failure.

The function runs application validation and transformations but does not execute prepared send Effects. For result fields, input errors, and failure snapshots, see the [routing reference](/reference/routing#preparation-compatibility).

If you need approval before submission, prepare the message with `Email.prepare` or the selected route's `prepare`. Retain that operation through approval. Then execute its send Effect while the Layer's scope remains open.

### Understand when fallback stops

Stop fallback after an unknown outcome, a conflict, a terminal receipt, a defect, or interruption. Only an eligible definite rejection permits another account. Partial, suppressed, and simulated receipts stop fallback.

Read the selected account from the routed receipt. Set `deadline` on the route plan to limit the complete chain. Do not reset the deadline for each account.

Persist route selection for recovery across executions. If a fallback account accepted the message, restarting at the primary can submit it again. Native replay guarantees apply to one provider account and do not transfer between routes.

For outcome types and retry rules, see [receipts, errors, and retries](./reliability).
