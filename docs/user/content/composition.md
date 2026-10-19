---
title: Defaults, preparation and observations
description: Apply defaults and transformations, review prepared messages and configure observations or capture.
---

Add wrappers to a configured account Layer to apply defaults, transform messages or observe results. Wrapper order determines whether callbacks receive values before or after defaults.

## Apply message defaults

`defaultedEmailLayer`, from `@corvencore/email-sdk/defaults`, applies reply-to, header, tag and metadata defaults, plus prefixes for caller-supplied keys. Set the sender, body and event key explicitly. The resulting message still passes provider validation.

`transformedEmailLayer`, from the root entrypoint, runs trusted application preparation and can return replacement message content. A transformation cannot replace operation policy or keys, or grant permission to dispatch after a failure. Supply Effects whose dependencies are already resolved.

Both wrappers require `Individual` personalization and reject `NativeAudience` Layers with `EmailConfigurationError`. Loops and Iterable have separate defaults entrypoints for their native jobs.

## Prepare a message for review

Use `email.prepare(message, options?)` when your application needs to review the effective message before dispatch. It returns:

- `previews`: owned candidate messages, options and route paths after preparation.
- `validate`: an Effect for local validation.
- `send`: an Effect for dispatching the prepared operation.

Review these previews, then validate or send that same operation while its supplying Layer scope remains open. Defaults and transformations must not run again after approval and change what was reviewed. Include keys, route paths and private execution context in the review decision.

Preparation does not submit a request, reserve remote capacity or extend a scope's lifetime. The operation is an in-process value, not a serialized approval token.

## Choose what to observe

| Need                                          | Public API                                                                           |
| --------------------------------------------- | ------------------------------------------------------------------------------------ |
| Minimal settled sender-call facts             | `@corvencore/email-sdk/observations`                                                 |
| Bounded private input and outcome capture     | `@corvencore/email-sdk/capture`, with explicit payload-capture permission            |
| Loops or Iterable operation facts and capture | `@corvencore/email-sdk/native-observations` / `@corvencore/email-sdk/native-capture` |
| Complete private prepared-operation outcomes  | Root `observedEmailOperationLayer`                                                   |
| Read-only named samples from existing views   | Capture and observation aggregation capabilities                                     |

Select the API for the operation you need to observe. Sender calls, prepared operations and grouped provider requests are recorded separately. A request can be submitted without appearing in a particular observation view.

Reuse the same Layer values for sending and querying so both paths acquire the same stores. Aggregated samples are not a globally atomic history or a lifetime delivery count.

## Protect captured data and outcomes

Callbacks are awaited application Effects. Their failures cannot roll back a provider acknowledgment or authorize retry or fallback.

Minimal observations exclude private payloads. Payload capture and complete operation callbacks expose private application data, so define access and retention rules before enabling them. Purging a visible capture or recording view does not securely erase previously returned snapshots or reset duplicate-prevention evidence.

## Detailed guides

- [Message defaults](/composition/defaults) and [transformations](/composition/transformations).
- [Minimal submission observations](/composition/observations), [private capture](/composition/capture) and [complete operation callbacks](/composition/operations).
- [Named account aggregation](/composition/aggregation).
- [Native job defaults](/composition/native-defaults) and [instrumentation](/composition/native-instrumentation).

For approval-driven workflows, see [agent and AI tools](./integrations#host-approved-agent-and-ai-tool).
