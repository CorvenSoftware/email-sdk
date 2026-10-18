---
title: API reference
description: Find the common service, message, options, receipt, sender, routing and offline CLI contracts.
---

Use installed declarations for exact generic errors and Effect service requirements. The references below explain public fields, methods and behavioral constraints without requiring imports from private implementation files.

## Common service and data

- [Email service](/reference/email): preparation, validation, sending, batching and personalization.
- [Message](/reference/message): addresses, content, headers, tags, metadata and owned input.
- [Attachments](/reference/attachments): acquisition helpers, byte bounds, MIME selection and placement.
- [Options and policy](/reference/options): keys, complete policy overrides, private context and concurrency.
- [Receipts](/reference/receipts): exact tags, IDs, count-only outcomes and recipient partitions.
- [Errors](/reference/errors): expected tags, safe fields and integration failure reasons.

## Providers and composition

- [Sender contract](/reference/sender): low-level validation/submission and the HTTP provider builder.
- [Routing](/reference/routing): named account bindings, plans and routed receipts.
- [Extension callbacks](/reference/callbacks): acquisition, retry restrictions and observation contracts.
- [Field support](/providers/field-support): declared base provider capabilities and configuration differences.
- [Composition](/composition): defaults, transformations, observations, capture and aggregation.

Import these common contracts from `@corven/email-sdk`. Account Layers, native jobs and optional integrations use the explicit subpaths described in their guides. Run `corven-email discover` for the installed export inventory.

## Offline CLI

The [CLI reference](/reference/cli) covers help, installed entrypoint discovery, selected provider profiles, partial JSON Schema and local request validation. It never acquires credentials or sends email.

## Runtime and scope

Check [installation](/getting-started/installation) for Node loading and optional peers, and [scope](/reference/scope) before assuming that a similarly named feature in another SDK is implemented here. Acceptance, authentication, delivery and installed typing are distinct evidence boundaries.
