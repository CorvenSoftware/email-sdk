---
title: Create an HTTP provider
description: Define a typed account Layer, credential-free preflight and request/response hooks using the public provider builder.
---

Import `defineEmailHttpProvider` from `@corvencore/email-sdk/provider`. Use it when capabilities, idempotency and local message rules are independent of account configuration.

## Define the protocol

This example describes a fictional API that accepts the complete normalized message and acknowledges it with a 202 response containing an ID. It is a contract example, not a ready-made integration for a real service.

<include lang="ts">/_examples/provider-authoring.ts.template</include>

The result exposes `profile`, `preflight`, `senderLayer` and `emailLayer`. The builder enforces declared capabilities before provider-specific validation. Unsupported attachments, headers, metadata, schedules, tags and keys are refused locally here.

## Own configuration and resources

Configuration arguments are decoded values validated against the Schema's type side; codec transformations and decoding defaults do not run. Acquire dependencies and resources inside `makeProtocol`, destructure retained configuration and keep credentials Redacted until constructing the request. Returned hooks must have their service requirements resolved.

The host supplies an HTTP client without hidden send retries, redirects or private logging. Use static, non-private provider/span labels.

## Classify evidence conservatively

Implement response rules for the provider's documented acknowledgments and rejections. Declare native idempotency only when the provider supports it for the selected account and operation. HTTP status, forwarded keys and Retry-After delays are not sufficient for that declaration. Reject unsupported fields. Return an unknown outcome for ambiguous transport or response failures. Leave retries and fallback to SDK policy.

For configuration-dependent protocols, SMTP or native jobs, implement the appropriate [sender contract](/reference/sender) rather than forcing them into this builder. Before shipping an extension, test public calls, local refusal, loopback wire behavior and installed consumers. Publication requires your own package/release process; the SDK has no community registry service.
