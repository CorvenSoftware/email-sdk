---
title: Mailgun webhooks
description: Verify Mailgun signature fields while retaining unverified event-body provenance.
---

Import the signature verifier and event parser from `@corven/email-sdk/mailgun-webhook`:

<include lang="ts">/_examples/mailgun-webhook.ts.template</include>

## Verify signature evidence

`MailgunWebhookVerifier.verifySignature` checks timestamp/token evidence with the configured Redacted signing keys and freshness tolerance. Select `signatureField` explicitly as `signature` or `parent-signature`; the appropriate choice depends on your ingress contract.

The proof covers the signature fields only. Event-body content remains unverified. Store the event with that provenance, even if signature verification succeeds.

## Project event reports

`parseMailgunWebhookEvent(rawBody)` returns supported Delivered, Failed, Complained or Other projections. Failures retain severity where supplied. Projected event provenance remains `UnverifiedPayload`.

Your host must acquire and authenticate the appropriate ingress, bind the account/tenant and retain durable replay state before applying a report. A valid signature, a body account field or a fresh timestamp alone is insufficient.

A recipient-server acceptance report is not permission to send again. Keep event interpretation separate from [outbound recovery policy](/reliability).
