---
title: Services and Layers
description: Roles of Email, EmailSender, provider Layers, and transport Layers.
---

`Email` separates application code from the provider account and transport. A program can use the same service dependency with a provider Layer or an offline recording Layer.

## Application service

`Email` handles message preparation, submission policy, batches, and personalization. Preparation decodes and copies inputs so later caller changes cannot alter the prepared message or options. Defaults, transformations, routing, and approval use that prepared operation.

Direct calls such as `Email.send(...)` return Effects that require `Email`. These Effects resolve the service when they run. Constructing an Effect does not acquire an account or submit email.

Direct calls, `Email.use`, and `yield* Email` use the same service. The [Email service reference](/reference/email) lists their methods, results, and errors.

## Provider services

`EmailSender` defines a provider name, capabilities, an idempotency declaration, local validation, and submission. `emailLayer` builds an `Email` service around an `EmailSender`.

`emailLayerFromSender` also provides the sender Layer. Provider convenience Layers, such as `resendEmailLayer`, already compose the sender with `emailLayer`.

Custom integrations can implement `EmailSender` when the [HTTP provider builder](/guides/authoring-provider) does not support their protocol or configuration. The [sender contract](/reference/sender) defines the required behavior.

## Transport dependencies

HTTP account Layers require `HttpClient`. The application provides the transport, including its redirect and retry settings. SMTP uses a socket and TLS transport instead.

Account configuration and transport configuration remain separate. The SDK accepts credentials as explicit inputs. An application can read credentials through Effect `Config` when it acquires a Layer.

The [provider guide](/sending) covers account setup, configuration, and transport settings.

## Resource lifetimes

The application controls the scope of acquired Layers. A prepared operation or AI tool does not extend the lifetime of the Layer that created it.

Recorder, capture, and observation queries need the same acquired state as the sender. Separate Layer acquisitions can create separate stores. Reusing a Layer value allows queries and submissions to share that state within a Layer build.
