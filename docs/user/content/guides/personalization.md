---
title: Personalize an email
description: Render recipient variables locally or deliberately choose a native grouped audience.
---

Use `sendPersonalized` for an explicit template and audience. Templates omit recipient fields; audience entries supply `to`, variables and optional keys.

<include lang="ts">/_examples/personalization.ts.template</include>

The preview helper needs no sender. The recording program expands two individual messages without contacting a provider.

## Template expansion

Variables use `%recipient.name%` syntax. Missing variables and invalid expanded messages remain failures. HTML expansion escapes text markup, but does not validate URL/CSS contexts or sanitize arbitrary HTML. Keep templates trusted and validate links in application code.

Every independent recipient operation has its own key. Shared options carry concurrency and execution context, not one key for the audience.

## Native grouped requests

Use `sendgridPersonalizedEmailLayer` or `mailgunPersonalizedEmailLayer` only when the provider's grouped operation matches your intent:

<include lang="ts">/_examples/native-personalization.ts.template</include>

Provide one of these account Layers to `submitNativeAudience`. Inspect `personalization: "NativeAudience"` on the acquired service. A valid subset can be submitted as one request with shared acknowledgment, deadline and correlation.

Common defaults, transformations and ordinary routing refuse native-audience Layers. They do not silently rerender or split the request. A per-audience Result is not proof of a separate wire send or independent recipient acceptance.

See [sending modes](/concepts/sending-modes) and [batching and routing](/batching-routing) for ordering and failure semantics.
