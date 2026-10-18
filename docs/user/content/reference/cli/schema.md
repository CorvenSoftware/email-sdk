---
title: corven-email schema
description: Export a partial JSON Schema document for local request tooling without replacing authoritative validation.
---

```sh
corven-email schema
```

The command writes a report containing a JSON Schema `document`, marked as a `PartialProjection`, with `corven-email validate` identified as the validation authority.

## Use it for structural tooling

The projection can help an editor or local form discover request structure. It does not fully represent custom refinements, provider-specific rules, account modes or every encoded Effect value.

Run [validate](/reference/cli/validate) on the complete envelope before treating input as locally valid. Then use the actual configured service for account-dependent checks. A generated Schema is not a credential check, a send lease or remote acceptance evidence.

The command reads no private request body and performs no provider operation. Do not use a successful JSON Schema check to remove or weaken SDK validation.
