---
title: Routing reference
description: Register named Email accounts, select a route plan and preserve actual route identity in receipts.
---

`emailRouterLayer(bindings, defaultPlan)` acquires named account Layers and exposes `EmailRouter`. A binding contains `name` and `layer`; names are bounded lowercase identifiers rather than private account labels.

## Route plan

| Field       | Meaning                                                      |
| ----------- | ------------------------------------------------------------ |
| `primary`   | Required registered route name                               |
| `fallbacks` | Optional nonempty ordered list of distinct registered routes |
| `deadline`  | Optional positive finite Effect Duration covering the chain  |

The primary and fallbacks must be distinct. `router.select(plan?)` returns an `IEmailRoute`; omit the argument to use the configured default plan. Routed sends return `EmailRoutedReceipt` values containing the actual route.

## Validation and authority

Every selected candidate's effective message, key and policy is preflighted before transport. Unsupported backup intent is a local failure; fields cannot be deleted during fallback. Routed capabilities describe shared support, not cross-account native replay.

Only eligible definite rejection advances the chain. Unknown outcomes, conflicts, terminal receipts, defects and interruption stop it. Native-audience candidates are refused rather than converted to individual execution.

## Instrumented accounts

`observedEmailRouterLayer` and `capturedEmailRouterLayer` retain named account views for [aggregation](/composition/aggregation). They do not make samples atomic or persist route selection across process restarts.

Use the [routed account example](/batching-routing#route-explicit-accounts) for complete public imports and transport composition. Your application owns durable selected-account recovery.
