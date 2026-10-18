---
title: Sender and provider contract
description: Define provider capabilities, local validation and request and response handling.
---

`EmailSender` is a public Effect service. `emailLayer` turns it into the common higher-level workflow. Normal consumers use configured provider convenience Layers.

## IEmailSender

| Member               | Contract                                                         |
| -------------------- | ---------------------------------------------------------------- |
| `provider`           | Static non-private provider identifier                           |
| `capabilities`       | Owned local feature declaration                                  |
| `idempotency`        | None, KeyForwarding or Native declaration with applicable bounds |
| `validate(message)`  | Closed Effect of void or `EmailInvalidMessage`; no submission    |
| `submit(submission)` | Closed Effect of `EmailReceipt` or `EmailSubmissionError`        |

`EmailSubmission` contains an owned decoded message and optional branded key. Keep account identity stable across attempts. Returned receipts and error classification must follow actual provider evidence.

## HTTP provider builder

`defineEmailHttpProvider` takes a configuration Schema, credential-free profile, static span label and `makeProtocol` acquisition Effect. It returns `profile`, `preflight`, `senderLayer` and `emailLayer`. See [the complete authoring example](/guides/authoring-provider).

The builder validates decoded configuration on the Schema's type side and enforces capability checks before provider-specific local rules. Hooks must close their dependencies; acquire resources inside `makeProtocol` and preserve the owning scope.

Use this builder only when local capabilities and idempotency do not depend on account configuration. More specialized adapters can implement `IEmailSender` directly.

## Author responsibilities

Encode every supported field or reject it before transport. Preserve ambiguous outcomes and expected rejection distinctions. Do not add hidden mutation retries, redirects, sensitive diagnostics or runtime execution inside a Layer factory.

A declared Native profile is a trusted author claim about the exact provider/account/operation, not a capability the SDK can discover from headers or IDs. Test protocol and public consumer behavior before claiming support; [verification boundaries](/providers/verification) still apply.
