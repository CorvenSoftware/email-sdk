---
title: Integrations
description: Connect React rendering, host-approved agents and provider-specific inbound reports to the core workflow.
---

Choose an integration by where it sits in your workflow. Rendering produces a body before submission; agent tools request host-approved dispatch; webhook processing receives provider reports afterward.

## React rendering

[Render trusted React email](/integrations/react) into HTML and plain text, then pass that body through ordinary provider validation and policy. Use [components and themes](/ui) for layouts and task-specific application recipes.

Optional rendering peers are isolated from core sending. Rendering is not sanitization, sending or a guarantee that every email client displays the same result.

## Host-approved agent and AI tool

[EmailAgent](/integrations/agent) restricts model proposals while the host owns sender, account, keys and approval. [emailAiTool](/integrations/ai) bridges that service into a scoped Standard Schema tool without acquiring a model client.

Keep the tool's scope open through execution. Model confirmation and framework approval flags never replace the host's decision over the effective prepared candidates.

## Inbound reports

The [webhook overview](/integrations/webhooks) separates verification, event projection, tenant binding and durable event replay. Use provider-specific guidance:

- [Resend](/integrations/webhooks/resend): raw-body/header verification before projection.
- [Mailgun](/integrations/webhooks/mailgun): timestamp/token proof, with event-body content still unverified.
- [Postmark](/integrations/webhooks/postmark): unsigned report projection under host-owned ingress authentication.

No inbound report grants permission to resend or bypass suppression. For platform integrations not provided by this SDK, keep queues, authentication and durable state in your application; see [scope and compatibility](/reference/scope).
