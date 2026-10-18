---
title: Message transformations
description: Prepare trusted replacement content without changing operation keys, policy or approved intent.
---

Use root `transformedEmailLayer` to run application-owned message preparation around an `Email` Layer:

<include lang="ts">/_examples/transformation.ts.template</include>

The transform receives owned message/options and returns replacement message input as an Effect. The example uses private execution context to choose a subject prefix; that context is not automatically forwarded to the provider.

## Preserve operation authority

A transform replaces message data, not operation keys or delivery policy. It cannot dispatch after local refusal or convert an observation failure into permission to resend. Its returned message still passes common decoding and provider validation.

Supply a closed callback, or an acquisition Effect that captures its dependencies within the Layer through `EmailExtension`. Resources acquired there last for the owning Layer scope; a returned prepared operation does not extend that lifetime.

## Review once

Prepare the message after defaults and transformations, review the actual candidates, and send that same prepared operation. Recomputing a transformation after approval can create content that was never approved.

This wrapper requires `Individual` personalization and rejects native audiences. For a provider-managed template, use the native job service rather than a transformation that silently changes the sending model.
