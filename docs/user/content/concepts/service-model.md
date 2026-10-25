---
title: Services and Layers
description: Understand how Email, EmailSender and provider Layers divide preparation, policy and transport.
---

An Effect program declares its service dependencies. A Layer provides those services. Write notification logic using `Email`, then provide a Layer for the selected provider account and transport.

## Email is the application service

Use `Email.send`, `Email.prepare`, `Email.validate`, `Email.sendAll`, and `Email.sendPersonalized` directly in an Effect pipeline. `Email.capabilities` and `Email.personalization` are Effects that inspect the provided account. These operations look up the current service when you run them; constructing them does not acquire an account or send email.

<include lang="ts">../_examples/effect-native.ts.template</include>

Run the Effect from your application entrypoint. You can still acquire `yield* Email` inside a generator or use `Email.use`; these styles share the same service and behavior.

Common preparation decodes inputs and owns their values so later caller mutation cannot change the submitted intent. Defaults, transformations, routing and approval work with that prepared operation.

## EmailSender

`EmailSender` supplies a provider name, local capabilities, an idempotency declaration, local message validation and submission. `emailLayerFromSender(senderLayer)` builds the common `Email` workflow and provides that sender in one step. It preserves acquisition errors, remaining requirements, resource scopes, and the existing policy, retry-observer, and retry-restriction arguments.

The lower-level `emailLayer` remains available when you want to provide `EmailSender` separately.

Normal applications use provider convenience Layers such as `resendEmailLayer`. Implement `EmailSender` directly only when authoring an integration whose protocol or configuration does not fit the HTTP provider builder.

## Configure an account with Effect

Read configuration explicitly in your application's Layer assembly, using Effect `Config` rather than library-owned environment lookups:

<include lang="ts">../_examples/effect-configuration.ts.template</include>

The Layer reads configuration when you acquire it. Missing configuration stays in the typed error channel; `Config.Redacted` keeps credentials Redacted. The application still supplies the HTTP client as shown in [sending](/sending#configure-transport-behavior). There is no separate SDK runtime to start or shut down.

## Transport is explicit

HTTP account Layers require `HttpClient` until the host provides one. The [sending example](/sending) supplies a client with redirects disabled. SMTP owns an explicit socket/TLS transport instead.

Keep resource scopes open for all Effects that use acquired services. A prepared value or AI tool does not extend the lifetime of the Layer that created it. Reuse the same Layer values when a recorder, capture query or observation view must share the sender's acquired store.

See [provider authoring](/guides/authoring-provider) and the [sender contract](/reference/sender) for extension boundaries.
