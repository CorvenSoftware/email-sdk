---
title: corven-email validate
description: Validate one private UTF-8 JSON request from stdin, optionally using a supported provider profile.
---

```sh
printf '%s' '{"message":{"from":"sender@example.test","to":"recipient@example.test","subject":"Example","body":{"text":"Fictional content"}}}' | corven-email validate
```

For provider-local checks, use `corven-email validate resend` or another name listed by [providers](/reference/cli/providers). The envelope is `{ message, options? }`, not a raw provider payload.

## Decode the input

Input must be one piped UTF-8 JSON request within the 32-MiB input bound. Ambiguous duplicate JSON fields, invalid encoding, invalid request shape and unsupported arguments are refused. Unknown message/option properties are not silently discarded.

Options use the CLI's JSON-compatible Schema representation. Do not assume that arbitrary serialized JavaScript `Date` or Effect Duration objects are valid input; use the [Schema projection](/reference/cli/schema) for structural guidance and this command as the actual local validator.

## Interpret success

A success report distinguishes common-only decoding from selected provider-local preflight. It marks authentication and delivery unchecked, and submission not attempted. A true local `valid` result is not a provider account check or permission to send.

Private input is not echoed. Keep credentials and private messages out of command-line arguments; pipe or redirect an authorized local input source instead. Expected input failures return exit status 1 with a safe error reason. Unsupported command usage returns 2.
