---
title: Corven Email SDK
description: Send transactional email from Effect programs with explicit providers, local validation and typed submission outcomes.
---

Corven Email SDK is a TypeScript library for Effect applications. Use `Email` to validate and send messages through a configured provider account. Provide the account Layer and transport in your application. For offline tests, use an in-memory recording Layer.

The SDK prepares messages and applies submission policy. Your application supplies credentials and stores queue and recovery state. The provider processes requests and delivers email.

## Get started

1. [Install the package](/getting-started/installation) for your supported Node and Effect versions.
2. [Record your first email](/quickstart) without credentials or network calls.
3. [Acquire account credentials](/getting-started/credentials) and [configure sending](/sending).
4. Choose a [provider guide](/providers) and validate the complete message.

## Providers and sending modes

Each [provider guide](/providers) explains configuration, supported intent, acknowledgments and replay limits. Use [field support](/providers/field-support) to compare local contracts, then run [preflight](/providers/capabilities) for actual provider rules.

Use ordinary `Email` for literal messages, batching and individual personalization. Native SendGrid/Mailgun audiences share a provider request. [Loops](/providers/loops) and [Iterable](/providers/iterable) use separate provider-managed job services. See [sending modes](/concepts/sending-modes) before treating these operations as interchangeable.

## Build application workflows

- [Batch and route messages](/batching-routing) or [personalize a template](/guides/personalization).
- [Apply defaults and transformations](/composition), then review the same prepared operation you dispatch.
- [Observe minimal facts](/composition/observations) or enable [authorized private capture](/composition/capture).
- [Render React bodies and application templates](/ui).
- [Approve agent requests](/integrations/agent), expose an [AI tool](/integrations/ai), or process [webhook reports](/integrations/webhooks).

## Operate and recover

A receipt describes the submission result. An accepted receipt does not confirm delivery. An unknown result means that the SDK could not determine whether the provider accepted the request. See [receipts and retries](/reliability) and [idempotency](/concepts/idempotency) before implementing retries.

Use the guides for [testing](/guides/testing), [scheduling](/guides/scheduling), [production pipelines](/guides/production-pipeline), [troubleshooting](/guides/troubleshooting) and [migration](/guides/migration). The [API reference](/reference) covers exact contracts and the offline CLI.

## Machine-readable documentation

[llms.txt](/llms.txt) is the categorized index. Append `.md` to a guide URL for its Markdown mirror, or use [llms-full.txt](/llms-full.txt) for the complete corpus. The [agent guide](/agents) describes focused retrieval and host-owned execution authority. This documentation site does not authenticate accounts or invoke a model.
