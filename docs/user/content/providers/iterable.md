---
title: Iterable triggered campaigns
description: Configure an Iterable campaign, recipient identity, data retention and tracking permissions.
---

Use `IterableCampaignEmail` from `@corvencore/email-sdk/iterable`. This native campaign service is separate from common literal-message sending and ordinary routing.

<include lang="ts">/_examples/iterable.ts.template</include>

Provide a safe HTTP Layer before execution. The host selects the US or EU account region and supplies the API key.

## Review required settings

Configuration requires an email-based project, provider-managed campaign authority, permission for profile creation, persisted send data and campaign tracking. These options record the application's permissions for provider behavior. They do not modify remote settings.

## Build a campaign job

Supply a positive campaign ID and lowercase `recipientEmail`. Optional `dataFields` support bounded scalars and scalar arrays; metadata is a separate bounded record. Optional `sendAt` uses a representable whole-second UTC instant and remains subject to native dispatch validation.

`validate` checks and owns the job without contacting the account. `sendAll` accepts native `{ job, options? }` envelopes and retains input order. The service does not implement the common personalization interface or turn campaign-managed content into a local template.

## Preserve replay limits

Idempotency keys are not supported. The SDK does not retry requests with unknown submission outcomes. An accepted receipt can omit the message ID. It does not confirm delivery.

Use [native defaults](/composition/native-defaults) for shared data fields, and [native instrumentation](/composition/native-instrumentation) for operation facts or authorized capture.
