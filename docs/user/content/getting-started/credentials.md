---
title: Credentials and account configuration
description: Acquire secrets in your application and supply the exact credentials and attestations required by each provider.
---

Use your existing provider account. Corven does not issue a platform API key, host an email account or authenticate against the documentation site.

## Acquire secrets in the host

Your application reads environment variables, a secret manager or another approved credential source and supplies `Redacted` values to provider Layers. The SDK does not discover `.env` files, cloud identity endpoints or account configuration.

`Redacted` reduces accidental disclosure; it does not make a secret safe to put in logs, telemetry, browser bundles or model input. Keep the value wrapped until the trusted request builder needs it.

## Match the provider's option names

Credential options differ: Resend uses `apiKey`, Postmark and MailPace use `serverToken`, Lettermint uses `apiToken`, and Cloudflare needs both `apiToken` and `accountId`. SES needs explicit signing credentials; Graph needs an access token acquired and refreshed by your host. SMTP has an explicit authentication union.

Select your [provider guide](/providers) for a complete configured Layer example. A token accepted by configuration validation can still lack remote sending permission.

## Review account attestations

Some Layers require literal settings such as `tracking: "DomainDisabled"` or `contactWrites: "AllowUpsert"`. These record what behavior your application permits or what remote settings it has checked. They do not cause the SDK to inspect, disable or enable anything remotely.

Review these choices before copying an example into production. In particular, profile writes, rendering, retention and automatic copies can change the privacy or content contract.

## Verify without sending

Use [local preflight](/providers/capabilities) to check message support without credentials. The [CLI](/reference/cli) is also offline. Neither authenticates an account. Live authentication and sending require separate operational controls; see [verification boundaries](/providers/verification).
