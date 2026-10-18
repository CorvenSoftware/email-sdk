---
title: Documentation for coding agents
description: Retrieve SDK documentation, use public imports and require application approval for sends.
---

Use [llms.txt](/llms.txt) to find a provider or task page. Append `.md` to the page URL to retrieve Markdown. Use [llms-full.txt](/llms-full.txt) to retrieve all pages.

The static [JSON page index](/api/docs/pages.json) links per-page JSON and Markdown forms. [agent-readability.json](/agent-readability.json) describes the emitted retrieval surfaces. These endpoints serve documentation. They do not provide credentials or execute sends.

## Integrate the library

1. Check [installation and runtime](/getting-started/installation) against the consuming application.
2. Import the common service from `@corven/email-sdk` and the account Layer from the selected [provider subpath](/providers).
3. Use fictional inputs and the [recording service](/guides/testing) first.
4. Validate complete intended fields and options before any authorized provider execution.
5. Preserve typed receipts, unknown outcomes and application-owned recovery state.

Keep source/declaration checks separate from runtime, authentication and delivery evidence. Do not copy provider flags or CLI commands from a different SDK, even when a service name matches.

## Expose a constrained tool

Use [EmailAgentApproval](/integrations/agent) and the scoped [AI tool bridge](/integrations/ai). Models propose limited content; the host owns sender, accounts, credentials, policy, keys and the approval decision. Tool-call IDs and model confirmation do not grant replay permission.

This documentation site does not host MCP, generate an installable agent skill, invoke a model or collect provider credentials. The SDK has no automatic account discovery or import-time provider calls.
