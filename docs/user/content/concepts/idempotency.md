---
title: Idempotency and retries
description: Check key support and provider requirements before retrying a request with an unknown outcome.
---

An idempotency key identifies one application operation in a provider account. A retry uses the same key and prepared request. In this documentation, replay means retrying a request whose submission outcome is unknown.

## Read the sender declaration

`EmailSenderIdempotencySchema` has three cases:

| Case            | Meaning                                                                                            |
| --------------- | -------------------------------------------------------------------------------------------------- |
| `None`          | Keys are unsupported and fail local validation.                                                    |
| `KeyForwarding` | The transport can forward a supported key, but the SDK cannot use it to replay an unknown outcome. |
| `Native`        | A provider-local replay contract exists for unchanged intent within its retention window.          |

Declarations can constrain key length, format and whether a key is required. The common key alphabet permits letters, digits, dots, underscores, colons, slashes and hyphens, but a provider can require a narrower alphabet.

## Keep identity stable

Persist a key with the logical event before dispatch. Reuse it only for that event, account and unchanged effective content. Include the effects of defaults and transformations when deciding whether intent is unchanged. A different account or route does not inherit the original account's duplicate-prevention guarantee.

A new SDK execution does not make an old key new. Your application must account for the provider retention window, process loss and any earlier backup acceptance.

## Check the configured profile

JetEmail and Primitive forward keys, but the SDK does not retry their requests after an unknown outcome. SendHeron's key support depends on attachment configuration. Lettr's key support depends on submission mode. Check the [provider guide](/providers) for the configured mode.

The provider's idempotency support, the delivery policy and the error reason must all permit the retry. See [receipts and retries](/reliability) and [delivery policy options](/reference/options).
