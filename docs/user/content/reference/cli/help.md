---
title: corven-email help
description: Display supported offline commands and their safety boundaries.
---

```sh
corven-email help
corven-email --help
```

Running `corven-email` without arguments also shows help. It describes installed discovery, selected provider preflight, partial Schema output and stdin request validation.

Help does not load credentials or contact a provider. Unknown commands and unsupported argument shapes return usage failure with exit status 2 instead of falling through to a live operation.

Use [discover](/reference/cli/discover) to inspect installed entrypoints or [validate](/reference/cli/validate) to check a JSON request. A help listing is not a statement that every provider account or remote feature is configured.
