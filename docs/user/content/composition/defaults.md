---
title: Message defaults
description: Apply shared reply-to, header, tag, metadata and key-prefix settings before provider validation.
---

Wrap an account with `defaultedEmailLayer` from `@corvencore/email-sdk/defaults`:

<include lang="ts">/_examples/defaults.ts.template</include>

The example leaves `HttpClient` as a required service. Provide your [safe transport Layer](/sending) in the application entrypoint.

## Merge rules

A caller's reply-to takes precedence over the default. Default headers and tags precede caller entries, so duplicates can still fail provider validation. Metadata merges with caller values taking precedence.

`idempotencyKeyPrefix` prefixes a caller-supplied key; it does not generate a key or authorize unrelated events to share one. The effective key must still satisfy the selected account's length and alphabet restrictions.

Sender, subject and body are not defaults in this wrapper. Set them explicitly in your notification program or a trusted transformation.

## Preparation order

Defaults are part of effective intent. Review the prepared message after they have been applied, and dispatch that same operation after approval. Wrapper order affects which values another transform or observer sees.

The common wrapper requires `Individual` personalization. A `NativeAudience` Layer fails acquisition with `EmailConfigurationError`. Use the separate [native defaults](/composition/native-defaults) for Loops or Iterable jobs.
