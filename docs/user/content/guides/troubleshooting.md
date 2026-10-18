---
title: Troubleshoot a failed send
description: Diagnose configuration, local validation, definite rejection and unknown outcomes without unsafe resends.
---

Start with the tagged error or receipt, not a generic transport exception. Preserve the provider, safe reason/category and issue paths while excluding credentials, recipient lists, content and original private causes from logs.

## Layer acquisition fails

`EmailConfigurationError` means no usable service was acquired. Check the provider's option names, required attestations and typed credential format. An unsupported wrapper around `NativeAudience` also fails here. Correct configuration before acquiring a new Layer.

## Input is refused locally

For `EmailInvalidMessage` or `EmailInvalidOptions`, inspect safe issue paths. Check the [message contract](/reference/message), [options](/reference/options) and provider-specific constraints. Handle unsupported fields, schedules and keys as validation errors. Change them only through an explicit application decision.

Use `corven-email validate` for common JSON input or a supported provider profile for credential-free checks. Passing these commands does not prove account authentication.

## The provider rejected the request

`EmailRejected` is definite rejection evidence. Authentication failures need account/credential correction. Invalid messages need input correction. Conflicts remain terminal. Only reasons eligible under the configured SDK policy permit retry or fallback.

## The outcome is unknown

For `EmailDeliveryUnknown`, retain a pending/uncertain state and reconcile. A timeout, invalid acknowledgment or server error is not an unsent result. Do not change accounts or keys to work around uncertainty. See [idempotency](/concepts/idempotency).

## An Effect was interrupted or defected

Keep the full cause semantics. Do not settle it as an ordinary failed batch item or select one typed failure from a compound cause to make it retryable. Observation failures cannot undo acceptance.

If behavior differs only in your installed application, check the exact runtime, Effect peer, package entrypoint and optional framework declarations. See the [error reference](/reference/errors) for field-level interpretation.
