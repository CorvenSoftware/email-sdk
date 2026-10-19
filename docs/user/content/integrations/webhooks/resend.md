---
title: Resend webhooks
description: Verify raw Resend webhook bytes and Svix headers before projecting supported event reports.
---

Use `ResendWebhookVerifier`, `resendWebhookLayer` and `parseResendWebhookEvent` from `@corvencore/email-sdk/resend-webhook`.

<include lang="ts">/_examples/resend-webhook.ts.template</include>

## Supply the original request

`ResendWebhookRequest` contains a raw `body` and an array of `{ name, value }` headers. Preserve the body exactly and retain duplicate-header evidence; rebuilding JSON or collapsing headers before verification can destroy the signed contract.

The verifier requires the Svix ID, timestamp and signature headers. Configuration accepts a bounded nonempty list of Redacted `whsec_` signing secrets for rotation and optional freshness tolerance. Use webhook signing secrets, not an outbound API key.

## Project verified evidence

Call `verify` first, then pass its `VerifiedResendWebhook` proof to `parseResendWebhookEvent`. Event normalization can still fail after signature verification if supported payload structure is invalid. A public observation Schema is not a replacement for this proof path.

Authentication does not bind your application tenant or persist event uniqueness. Own those decisions at ingress and apply reports under durable replay control. Verification failure must not trigger a send or turn the event into trusted delivery state.
