---
title: Process webhook reports
description: Separate ingress authentication, event projection, tenant binding and durable replay handling.
---

Provider reports can help reconcile submission state, but their proof scopes differ. Select the integration that matches the provider and the evidence your application actually receives.

| Provider                                    | SDK support                                                          | Trust boundary                                         |
| ------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------ |
| [Resend](/integrations/webhooks/resend)     | Raw-body/header verification and event projection                    | Projection consumes verified request evidence          |
| [Mailgun](/integrations/webhooks/mailgun)   | Timestamp/token signature verification and separate event projection | The signature does not authenticate event-body content |
| [Postmark](/integrations/webhooks/postmark) | Unsigned event projection                                            | Ingress authentication remains application-owned       |

## Receive the request safely

Acquire the raw body and complete required headers before lossy middleware transforms them. Preserve duplicate-header evidence where the verifier needs it. Keep secrets, payloads and original parser failures out of diagnostics.

Bind the request to the intended tenant/account using trusted ingress, not an unsigned account field in the payload. Configure key rotation and freshness within the actual provider verification contract.

## Apply events idempotently

Persist replay state and event application decisions in your application. Freshness is not uniqueness; a valid signature does not prove that the event is new or represents the latest delivery state.

A projected Delivered event is a provider report, not a universal inbox-placement guarantee. Parsing a serialized observation Schema does not recreate authentication. No webhook event authorizes resending, bypassing suppression or changing consent.

For outbound state, retain [receipts and uncertainty](/reliability) separately from inbound reports.
