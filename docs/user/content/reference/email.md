---
title: Email service reference
description: Exact common service methods, expected failures, prepared-operation members and routed result differences.
---

Import `Email` and `IEmail` from `@corvencore/email-sdk`. Acquire the service inside an Effect and provide a configured Layer before execution.

## Methods

| Method                              | Success                                                  | Expected failure                                                         |
| ----------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------ |
| `prepare(message, options?)`        | `EmailPreparedOperation`                                 | `EmailInvalidMessage`, `EmailInvalidOptions`, `EmailRejected`            |
| `validate(message, options?)`       | `EmailMessage`                                           | `EmailInvalidMessage`, `EmailInvalidOptions`, `EmailRejected`            |
| `send(message, options?)`           | `EmailReceipt`                                           | `EmailSendError`                                                         |
| `sendAll(requests, options?)`       | Readonly array of `Result<EmailReceipt, EmailSendError>` | `EmailInvalidOptions` for invalid batch options                          |
| `sendPersonalized(input, options?)` | Readonly array of `Result<EmailReceipt, EmailSendError>` | `EmailInvalidMessage`, `EmailInvalidOptions` for invalid operation input |

All methods return Effects. Per-item expected batch failures live inside Results; defects and interruption remain Effect causes. Layer acquisition errors belong to composition before these methods are available.

## Prepared operation

`previews` is a statically nonempty readonly sequence of `EmailPreparedPreview` values. Each contains `message`, `options` and `routes` after effective preparation. `validate` is an Effect returning void; `send` is an Effect returning the receipt or `EmailSendError`.

Preparation runs local checks without submitting. After review, execute the same prepared operation while its scope remains open. The operation is not a persistent approval record. Executing its send Effect again requires the same retry checks as any other send.

## Service properties

`capabilities` describes the configured service's locally supported features. `personalization` is `Individual` or `NativeAudience`. Neither property authenticates a remote account.

`IEmailRoute` extends the service with routed receipts containing `route`. Native Loops/Iterable services are separate interfaces, not implementations of this common literal-message contract. See [sending modes](/concepts/sending-modes) and [routing reference](/reference/routing).
