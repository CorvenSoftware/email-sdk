---
title: Build a production send pipeline
description: Connect durable application state to local preparation, provider dispatch and outcome reconciliation.
---

A production pipeline needs application-owned state around `Email`. The SDK supplies preparation and submission policy; it does not persist a queue or guarantee exactly-once delivery.

## 1. Record the logical event

Persist an event identity, authorized recipients/content and the intended provider account. Store a stable scoped key only when that account supports it. Keep secrets outside queue payloads and define retention for private message data.

## 2. Prepare the effective operation

Acquire the configured Layer and call `prepare`. Review the candidate previews after defaults, transformations and routing. If human or host approval is required, approve these values and dispatch the same operation while its scope remains open.

Local validation catches unsupported intent. It does not authenticate the account or lock remote capacity. Time-sensitive constraints can fail later without making it acceptable to change approved intent.

## 3. Dispatch within a bounded policy

Use a complete delivery policy and a transport without hidden retries or redirects. Only eligible definite rejection can advance fallback. Native replay support belongs to one provider account and unchanged request, not to the queue record alone.

## 4. Retain the actual outcome

Persist the complete receipt or an explicit uncertain state. Preserve partial recipient evidence, count-only outcomes, suppression and the actual routed account. A message ID is a correlation handle, not a delivered flag.

## 5. Reconcile asynchronously

Apply authenticated or explicitly unverified [webhook reports](/integrations/webhooks) under your ingress trust policy. Keep tenant binding and event replay storage durable. An absent report does not establish non-submission, and a duplicate report must not trigger another send.

On process recovery, resume from retained account/key/outcome evidence. Restarting every job at the primary after a previous backup acceptance can duplicate email.
