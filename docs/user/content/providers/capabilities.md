---
title: Capabilities and local preflight
description: Inspect supported fields and validate complete provider intent without acquiring credentials or sending.
---

Use `email.capabilities` to inspect the configured service, then call `email.validate` to apply preparation and the actual provider rules. A capability flag is a local support declaration, not a statement about account permission or remote acceptance.

## Preflight without an account

Selected provider subpaths expose credential-free functions:

<include lang="ts">/_examples/preflight.ts.template</include>

This example validates the same message for Resend and Postmark, but supplies a key only to Resend. Giving Postmark an unsupported key must remain a local refusal.

A preflight function needs neither credentials nor an HTTP client. It does not authenticate, inspect account settings, reserve a schedule or prevent a later remote rejection. The [CLI providers command](/reference/cli/providers) lists the available offline profiles.

## Preserve complete intent

The [field-support table](/providers/field-support) describes base profiles. Provider validation can add restrictions on mailbox formatting, body combinations, MIME types, tag syntax, header names, schedules and recipient evidence.

Do not delete a rejected field to force portability. Decide in application code whether a different message is acceptable, then prepare and approve that new intent explicitly.

## Routed candidates

Routing preflights every selected candidate's effective message, key and policy before transport. A compatible primary does not excuse an incompatible backup. The acquired routed capabilities describe common support, but they do not replace candidate validation or create cross-account replay guarantees.
