---
title: Native job defaults
description: Apply Loops variables and Iterable data/metadata defaults without changing the native service contract.
---

Loops and Iterable use native jobs rather than the common literal-message envelope. Their defaults live in separate entrypoints.

## Loops

<include lang="ts">/_examples/loops-defaults.ts.template</include>

`defaultedLoopsTransactionalLayer` supplies default `dataVariables` and an optional caller-key prefix. The application still selects the published template and recipient. It does not transform a native template into common `Email` content.

## Iterable

<include lang="ts">/_examples/iterable-defaults.ts.template</include>

`defaultedIterableCampaignLayer` merges default data fields and metadata. Caller values take precedence. The resulting job still passes native campaign validation, including project identity and scheduling constraints.

The examples leave HTTP transport to the application. Configuration attestations retain their original meaning after wrapping: defaults do not inspect remote templates, enable attachments, disable tracking or acquire profile-write permission.

See [Loops](/providers/loops) and [Iterable](/providers/iterable) for the native input and replay boundaries.
