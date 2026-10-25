---
title: Batching, personalization and routing
description: Send ordered batches, personalize messages and configure fallback between named provider accounts.
---

Use `sendAll` for independent messages, `sendPersonalized` for one template and an audience, or named account routing to choose where a message is submitted.

## Send a batch

`sendAll` accepts an array of `{ message, options? }` envelopes and a bounded concurrency setting:

<include lang="ts">./_examples/batching.ts.template</include>

Provide an `Email` Layer when running this program, as shown in [sending](./sending) or the offline [quickstart](./quickstart).

Each request has its own key and delivery policy. There is no batch-wide key for unrelated messages. Results retain input order even when messages finish in a different order; expected item failures appear as Effect Results.

Defects and interruption cancel active work and propagate. Already accepted messages cannot be undone. A batch is neither an atomic transaction nor an implicit provider-native bulk request.

## Stream independent messages

Use `sendEmailStream` for an incremental source of request envelopes:

<include lang="ts">./_examples/streaming.ts.template</include>

Consume this stream with an Effect Stream runner and provide an `Email` Layer. Results arrive in source order as `{ index, result }`, with a zero-based index for the complete source. The concurrency setting bounds active item submissions. Each item keeps its own key and policy.

The helper owns each request when it processes that request. Preparation runs once per item, including every selected route candidate. Unlike `sendAll`, streaming does not prepare the complete source before sending. A sparse source does not wait for a full batch.

Expected item failures become Results. Upstream failures, defects, and interruption stop the stream. Stopping consumption interrupts active work but cannot undo accepted submissions. Preserve outcomes as you consume them. A stream failure does not prove that previous or in-flight work was unsent.

## Personalize a message

`sendPersonalized` takes a template without recipient fields and an explicit audience. Each audience member supplies a mailbox, template variables and an optional idempotency key. Shared options specify concurrency and context, not one key for the whole audience.

With the default `Individual` mode, the SDK expands the template into per-recipient messages. Use `renderEmailPersonalizedMessage` to preview expansion without a sender. HTML expansion escapes text markup, but does not validate URL or CSS contexts or sanitize arbitrary HTML. Missing variables and invalid expanded messages remain failures.

### Use native personalization

Opt-in SendGrid and Mailgun Layers can submit a valid subset of the audience in one native request. Recipients then share request-level acknowledgment, deadline and correlation.

Check the configured `personalization` mode. Common defaults, transformation wrappers and ordinary routing reject `NativeAudience` Layers; they do not silently expand them into individual sends. A shared method name does not imply independent wire requests or per-recipient acknowledgment.

## Route explicit accounts

Register a Layer for each named account, then select a route through `EmailRouter`:

<include lang="ts">./_examples/routing.ts.template</include>

The example uses the HTTP Layer from [sending](./sending) and deliberately omits an idempotency key: every candidate, including Postmark, must support the requested key.

Construction-time default plans infer literal names from the registrations. With inferred type arguments, TypeScript rejects an unregistered primary or fallback name when every registration has a literal name. Dynamic names and legacy explicit `emailRouterLayer<E, R>` calls retain runtime validation. This inference does not narrow the globally provided `EmailRouter.select` method.

Before transport, the router preflights the effective message, options and policy for every selected candidate. An unsupported field or key on a backup fails locally instead of being dropped.

### Explain a route plan without sending

`explainEmailRoutePlan(plan, request)` checks an explicit plan against the acquired accounts and returns ordered `Compatible` or `Incompatible` candidates. Each incompatible candidate carries the existing typed preparation failure. The explanation contains no message previews or idempotency keys.

<include lang="ts">./_examples/route-explanation.ts.template</include>

Invalid message/options or malformed plan shape fail before candidate preparation. The result lists unknown route names and incompatible account modes as candidate failures. Defects and interruption stop the explanation instead of becoming incompatibility results.

This runs normal preparation, including application transformations and validation, but never invokes an operation's send Effect. It is a diagnostic snapshot, not approval, provider acceptance, or replay authority. If an application will approve and send a prepared intent, use `Email.prepare` or the selected route's `prepare` and retain that operation instead of explaining and preparing again.

`EmailRouter.routes` inspects registered account metadata, and `EmailRouter.select(plan?)` selects a route directly as an Effect. The existing yielded-service style remains supported.

### Understand when fallback stops

Only an eligible definite rejection advances to a fallback account. Unknown outcomes, conflicts, terminal receipts, defects and interruption stop the chain. Partial, suppressed and simulated receipts are terminal outcomes, not reasons to try a backup.

Routed receipts identify the account selected. One routing deadline covers the whole chain rather than resetting for each account.

Persist route selection for recovery across later executions. If a backup previously accepted the email, restarting at the primary can duplicate it. Native replay guarantees remain local to a provider account; they do not transfer across routes. See [receipts, errors and retries](./reliability).
