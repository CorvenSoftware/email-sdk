---
title: Amazon SES
description: Send through the SES v2 regional API with explicit signing credentials.
---

Import `sesEmailLayer` from `@corven/email-sdk/ses` to provide the common `Email` service for this account.

## Configure the account

<include lang="ts">/_examples/provider-ses.ts.template</include>

The example reuses the [explicit HTTP Layer](/sending#configure-transport-behavior). Acquire credentials in trusted host code, then provide this account Layer to your sending program.

## Message behavior

- The SDK signs requests itself using supplied accessKeyId, secretAccessKey and optional sessionToken. It does not use an ambient AWS credential chain.
- Supported regions are us-east-1, us-west-2 and eu-west-1. mailFlow attests that provider behavior preserves the message data.
- Use explicit MIME types and supported attachment extensions. Common metadata and scheduling are unsupported; bounded ASCII tags are available.

## Idempotency

Idempotency keys are not supported. The SDK does not retry requests with unknown submission outcomes.

Read [field support](/providers/field-support) before switching accounts, and [receipts and retries](/reliability) before adding recovery behavior. Configuration and local validation do not authenticate the account or prove delivery.
