---
title: Approve agent-requested email
description: Let a model propose content while the host owns sender, account, keys, policy and approval.
---

Use `EmailAgent` from `@corven/email-sdk/agent` to expose a constrained proposal boundary. Model input contains `to`, `subject` and `body`. The host supplies the sender and the configured `Email` service.

<include lang="ts">/_examples/agent.ts.template</include>

The account Layer still needs HTTP transport. The sample accepts a host review callback rather than automatically approving proposals.

## Review effective candidates

`EmailAgentApproval.review` receives owned `message`, `options` and all effective `previews`. Defaults, transformations and routes have already been prepared, so review the actual candidates rather than the model's earlier draft.

Return `Approved` only when host policy permits that exact operation. `Declined` fails with `EmailAgentApprovalError`; unavailable review must remain an explicit failure. The SDK validates and dispatches the same prepared operation after approval.

## Keep authority in the host

Do not accept model-supplied sender accounts, credentials, route policy or replay keys as authority. Framework approval flags, confirmation text and tool-call IDs do not replace `EmailAgentApproval`.

Approval does not prove account permission, submission or delivery. A failed or interrupted tool call can leave the outcome unknown, so do not retry automatically. Use [AI tools](/integrations/ai) for a framework bridge and [prepared operations](/composition) for scope and callback semantics.
