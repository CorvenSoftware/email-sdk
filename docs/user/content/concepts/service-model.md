---
title: Services and Layers
description: Understand how Email, EmailSender and provider Layers divide preparation, policy and transport.
---

An Effect program declares its service dependencies. A Layer provides those services. Write notification logic using `Email`, then provide a Layer for the selected provider account and transport.

## Email is the application service

Acquire `Email` to validate, prepare, send, batch or personalize messages. Its methods return Effects; constructing an Effect does not execute a provider call. Provide an account Layer or an offline recording Layer where your application provides Layers.

Common preparation decodes inputs and owns their values so later caller mutation cannot change the submitted intent. Defaults, transformations, routing and approval work with that prepared operation.

## EmailSender

`EmailSender` supplies a provider name, local capabilities, an idempotency declaration, local message validation and submission. `emailLayer` builds the common `Email` workflow around that capability.

Normal applications use provider convenience Layers such as `resendEmailLayer`. Implement `EmailSender` directly only when authoring an integration whose protocol or configuration does not fit the HTTP provider builder.

## Transport is explicit

HTTP account Layers require `HttpClient` until the host provides one. The [sending example](/sending) supplies a client with redirects disabled. SMTP owns an explicit socket/TLS transport instead.

Keep resource scopes open for all Effects that use acquired services. A prepared value or AI tool does not extend the lifetime of the Layer that created it. Reuse the same Layer values when a recorder, capture query or observation view must share the sender's acquired store.

See [provider authoring](/guides/authoring-provider) and the [sender contract](/reference/sender) for extension boundaries.
