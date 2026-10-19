# Authoring HTTP email providers

Import `defineEmailHttpProvider` and the authoring types/helpers from `@corvencore/email-sdk/provider`. The [installed author example](../../scripts/package-author-consumer.ts.template) defines a provider using only public imports; [package verification](../../scripts/check-package.sh) compiles and runs it from both ESM and CommonJS consumers.

A definition supplies a configuration Schema, a credential-free profile, a static non-private span label, and an Effect that acquires request/response hooks. The result provides `profile`, `preflight`, `senderLayer` and `emailLayer`. Configuration and acquisition error/requirement types are inferred; the convenience email Layer also supports acquired retry observers and restrictions.

## Definition versus configured account

Use this builder only when capabilities, idempotency and local validation are independent of account configuration. Explicit non-secret settings can select separate definitions. Configuration-dependent adapters, SMTP and native jobs can continue implementing the public `IEmailSender` or their existing specialized interfaces; they need not fit this HTTP builder.

Configuration arguments are **decoded values**, validated against the Schema's type side. Codec transformations/default decoding are not run. Layer arguments are borrowed until acquisition: Schema validation is not a general deep copy. Destructure or otherwise own retained configuration values during `makeProtocol`, and keep credentials Redacted until request construction. Acquire dependencies/resources inside that Effect; its scope lasts for the owning Layer. Returned hooks must close their service requirements.

Preflight acquires neither configuration nor transport. It validates supported intent/options, not credentials, provider acceptance or delivery. The builder owns profile metadata and enforces declared capabilities before provider-specific validation, including through the low-level sender. Provider-specific rules remain responsible for constraints beyond those capabilities. Time-sensitive rules are checked again on submission.

## Provider code remains trusted

Profiles, hooks and their callback closures are trusted host code. The builder cannot establish that an author correctly classified acknowledgement evidence or truthfully claimed native idempotency. `Native` must cover the actual provider/account/endpoint and unchanged intent; forwarded keys and parsed retry delays grant no replay authority. Keep account identity stable across attempts and leave retries/fallback to SDK policy.

Encode every supported field explicitly and reject unsupported intent. Do not infer acknowledgement from status or an ID alone. Request encoding may reject before transport; uncertain transport/response outcomes must stay unknown. Hooks cannot override definition metadata by returning additional properties. Use safe static provider/span labels, never account values, credentials, keys or message content.

The named helpers retain their existing contracts: [credential schemas](../../src/email-http-credential.ts), [bounded JSON response reading](../../src/email-http-response.ts), and [numeric-seconds Retry-After parsing](../../src/email-http-retry-after.ts). They do not supply provider-specific response interpretation or replay permission.

The [authoring tests](../../src/email-provider.test.ts), [typed call sites](../../test/email-contracts.tst.ts), and existing Resend/Postmark wire/conformance tests exercise these boundaries. Synthetic/loopback/installed-consumer evidence does not authenticate a real provider or establish delivery.
