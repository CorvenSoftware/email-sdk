---
title: Email service reference
description: Email methods, service properties, prepared operations, and Layer requirements.
---

`Email` and `IEmail` are exports of `@corvencore/email-sdk`.

Direct calls such as `Email.send(...)` return Effects that require `Email`. The methods on a service acquired with `yield* Email` have the same results and errors.

## Methods

| Method                              | Success                                                  | Expected failure                                                         |
| ----------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------ |
| `prepare(message, options?)`        | `EmailPreparedOperation`                                 | `EmailInvalidMessage`, `EmailInvalidOptions`, `EmailRejected`            |
| `validate(message, options?)`       | `EmailMessage`                                           | `EmailInvalidMessage`, `EmailInvalidOptions`, `EmailRejected`            |
| `send(message, options?)`           | `EmailReceipt`                                           | `EmailSendError`                                                         |
| `sendAll(requests, options?)`       | Readonly array of `Result<EmailReceipt, EmailSendError>` | `EmailInvalidOptions` for invalid batch options                          |
| `sendPersonalized(input, options?)` | Readonly array of `Result<EmailReceipt, EmailSendError>` | `EmailInvalidMessage`, `EmailInvalidOptions` for invalid operation input |

All methods return Effects. Expected failures for individual batch items appear in Results. Defects and interruption remain Effect causes. Layer acquisition can fail before a method runs.

## Prepared operation

`EmailPreparedOperation` has these members:

- `previews` is a nonempty readonly sequence of `EmailPreparedPreview` values. Each preview contains the prepared `message`, `options`, and `routes`.
- `validate` is an Effect that runs local validation and returns void.
- `send` is an Effect that returns a receipt or fails with `EmailSendError`.

Preparation does not submit email. A prepared operation retains the input used by its send Effect. The operation does not extend its Layer's scope or persist an approval record. Each execution of the send Effect remains subject to replay checks.

## Service properties

On an acquired service, `capabilities` describes supported features. `personalization` is `Individual` or `NativeAudience`.

The static accessors `Email.capabilities` and `Email.personalization` return Effects that require `Email`. These accessors read local account configuration. They do not authenticate the remote account.

## Sender Layer

`emailLayerFromSender(senderLayer, policy?, observer?, restriction?)` is equivalent to `emailLayer(policy, observer, restriction).pipe(Layer.provide(senderLayer))`.

The helper preserves typed acquisition errors and remaining service requirements. Its output provides `Email`, not unused outputs from the sender Layer. The helper does not extend the lifetime of acquired resources.

## Related services

`IEmailRoute` extends `IEmail` with receipts that contain `route`. The [routing reference](/reference/routing) describes route selection and fallback.

Native Loops and Iterable services use separate interfaces. They do not implement the common literal-message contract. The [sending modes](/concepts/sending-modes) page describes these interfaces.
