---
title: Postmark webhook reports
description: Parse unsigned Postmark delivery, complaint and bounce reports after application-level ingress checks.
---

Use `parsePostmarkWebhookEvent` and `PostmarkWebhookEventSchema` from `@corven/email-sdk/postmark-webhook`:

<include lang="ts">/_examples/postmark-webhook.ts.template</include>

## Understand the projection

Supported cases include Delivered, Complained, Bounced for a hard bounce, BounceReported for other supported bounce reports, and Other. Bounce type/code consistency is checked; do not collapse every native bounce report into a hard-bounce claim.

All projections retain `UnverifiedPayload` provenance. This entrypoint does not provide a request signature verifier. Your application owns ingress authentication, tenant binding, raw-body acquisition and event replay storage.

## Apply reports carefully

Treat the event as a provider-shaped report under the trust your ingress establishes. Parsing alone does not establish that Postmark sent it, that the event is new or that it reflects the latest recipient state.

Preserve correlation and recipient evidence without logging private payloads. A bounced, complained or suppressed recipient must not be routed automatically to another account. See the [webhook overview](/integrations/webhooks) for application replay and state ownership.
