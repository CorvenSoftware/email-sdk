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

The primary and fallbacks must be distinct. `EmailRouter.select(plan?)` returns an Effect requiring `EmailRouter` and yielding `IEmailRoute`; omit the argument to use the configured default plan. `EmailRouter.routes` yields the registered route metadata. The same members remain available on `yield* EmailRouter`. Routed sends return `EmailRoutedReceipt` values containing the actual route.

## Preparation compatibility

`explainEmailRoutePlan(plan, request)` requires `EmailRouter`. Its success value is `EmailRoutePlanExplanation`: a `compatible` boolean and a nonempty ordered `candidates` array. Each `EmailRouteCompatibility` has a `Compatible` or `Incompatible` tag and a `name`. Incompatible candidates also have an `EmailInvalidMessage`, `EmailInvalidOptions`, or `EmailRejected` snapshot.

`EmailRouteCompatibilitySchema` and `EmailRoutePlanExplanationSchema` encode/decode these values. The explanation Schema checks that the boolean agrees with every candidate. Returned failures retain only modeled fields, omit original causes and extra runtime properties, and detach/freeze issue arrays. Application-authored issue text and provider labels must still follow the SDK's private-data restrictions.

Malformed plan/message/options fail in the typed `EmailInvalidOptions` or `EmailInvalidMessage` channel before candidate preparation. An unknown name or an incompatible selected account appears as a candidate failure. Defects and interruption propagate. Checks run sequentially in plan order and never execute prepared send Effects.

The result is only a local preparation snapshot. It neither reserves transport capacity nor creates approval, acceptance, or replay authority. See the [explanation example](/batching-routing#explain-a-route-plan-without-sending).

## Validation and authority

Every selected candidate's effective message, key and policy is preflighted before transport. Unsupported backup intent is a local failure; fields cannot be deleted during fallback. Routed capabilities describe shared support, not cross-account native replay.

Only eligible definite rejection advances the chain. Unknown outcomes, conflicts, terminal receipts, defects and interruption stop it. Native-audience candidates are refused rather than converted to individual execution.

## Instrumented accounts

`observedEmailRouterLayer` and `capturedEmailRouterLayer` retain named account views for [aggregation](/composition/aggregation). They do not make samples atomic or persist route selection across process restarts.

Use the [routed account example](/batching-routing#route-explicit-accounts) for complete public imports and transport composition. Your application owns durable selected-account recovery.
