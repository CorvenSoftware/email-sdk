---
title: Scope and compatibility
description: Distinguish implemented SDK workflows from similarly named features in other email libraries or hosted products.
---

Corven is an Effect-native email library with explicit provider Layers, local validation and typed submission evidence. It uses your existing provider accounts and runs inside your application.

## Supported features

The [provider guides](/providers) describe ordinary literal-message Layers and the separate native Loops/Iterable services. The package also includes local recording/failing services, preparation/defaults/transformations, named routing, observation/capture views, React rendering, host-approved agent tools and selected webhook verification/projection.

The [CLI](/reference/cli) is offline. [Machine-readable documentation](/agents) consists of static retrieval artifacts. Neither is a hosted email account, authentication endpoint or sending service.

## Application requirements

Durable queues, background schedulers, provider account provisioning, DNS configuration, delivery reconciliation and persistent webhook replay storage belong to the host application. The SDK does not supply a first-party Convex component, Chat SDK integration, CRM or campaign builder.

Graph tokens are host-acquired; there is no built-in OAuth discovery/refresh workflow. Cloudflare sending uses REST, not a Workers binding or inbound routing handler. These restrictions differ from capabilities advertised by some similarly named integrations in other libraries.

## Documentation comparisons

This site includes [field support](/providers/field-support), decision-oriented [provider comparisons](/guides/provider-comparisons) and application React recipes. It does not claim a hosted preview service, community registry, universal plugin compatibility layer, provider pricing feed, DNS checker, blog history or migration compatibility with another SDK's releases.

Use [runtime requirements](/getting-started/installation) for supported Node loading. A compiled example does not establish every runtime, bundler, remote account prerequisite or live delivery guarantee.
