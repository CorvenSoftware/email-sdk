---
title: Offline CLI reference
description: Inspect installed exports and validate JSON requests locally with corven-email.
---

The package installs `corven-email`. It performs offline inspection only: no credential acquisition, environment discovery, authentication, host approval, sending or telemetry exporter is added by these commands.

| Command                            | Reference                                           |
| ---------------------------------- | --------------------------------------------------- |
| `corven-email help` / `--help`     | [Usage](/reference/cli/help)                        |
| `corven-email discover`            | [Installed entrypoints](/reference/cli/discover)    |
| `corven-email providers`           | [Local provider profiles](/reference/cli/providers) |
| `corven-email schema`              | [Partial JSON Schema](/reference/cli/schema)        |
| `corven-email validate [provider]` | [Request validation](/reference/cli/validate)       |

From a checkout, run `pnpm build` and replace `corven-email` with `node dist/email-cli-main.js`.

## Input and output

Validation reads one UTF-8 JSON envelope from piped stdin. The envelope has `message` and optional `options`. It is not a raw provider payload. Private input is never echoed in reports.

Successful commands write their report to stdout. Expected failures write a safe JSON error to stderr. Exit status is 0 for success, 1 for a validation/environment failure and 2 for invalid command usage.

## Unsupported commands

There is no `send`, `auth`, `doctor` or host-bound dry-run command. Do not copy commands from another SDK with a similar name. Local validity does not establish remote authentication, acceptance or delivery; [provider verification](/providers/verification) explains the distinction.
