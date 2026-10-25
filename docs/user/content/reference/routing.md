---
title: Routing reference
description: Router Layers, route plans, compatibility results, and fallback rules.
---

`emailRouterLayer(bindings, defaultPlan)` acquires named account Layers. It provides `EmailRouter` and an `Email` service for the default plan.

Each binding contains `name` and `layer`. Route names are bounded lowercase identifiers, not private account labels.

## Router methods

`EmailRouter.routes` returns an Effect that requires `EmailRouter` and yields the registered account metadata.

`EmailRouter.select(plan?)` returns an Effect that requires `EmailRouter` and yields `IEmailRoute`. An omitted plan selects the configured default. These members are also available on the service acquired with `yield* EmailRouter`.

Routed sends return `EmailRoutedReceipt` values with the actual route name.

## Route plan

| Field       | Meaning                                                      |
| ----------- | ------------------------------------------------------------ |
| `primary`   | Required registered route name                               |
| `fallbacks` | Optional nonempty ordered list of distinct registered routes |
| `deadline`  | Optional positive finite Effect Duration covering the chain  |

The primary and fallback names must be distinct.

Default plans infer literal names from the registrations. With inferred type arguments, TypeScript rejects an unregistered name when every registration has a literal name. Dynamic names and explicit `emailRouterLayer<E, R>` calls use runtime validation. The global `EmailRouter.select` method validates names at runtime.

## Preparation compatibility

`explainEmailRoutePlan(plan, request)` requires `EmailRouter`. The function runs preparation for each candidate in plan order. It does not execute prepared send Effects.

The result, `EmailRoutePlanExplanation`, has these fields:

| Field        | Meaning                                                           |
| ------------ | ----------------------------------------------------------------- |
| `candidates` | Nonempty array of `EmailRouteCompatibility` values in plan order. |
| `compatible` | `true` when every candidate is `Compatible`.                      |

Each candidate has a `name` and a `Compatible` or `Incompatible` tag. An `Incompatible` candidate also has a `failure` containing an `EmailInvalidMessage`, `EmailInvalidOptions`, or `EmailRejected` snapshot.

The function rejects a malformed plan, message, or options before candidate preparation. These failures use the typed `EmailInvalidOptions` or `EmailInvalidMessage` channel. Unknown names and unsupported account modes produce `Incompatible` candidates. Defects and interruption stop the operation and propagate as Effect causes.

Failure snapshots contain only modeled fields. The SDK copies and freezes the failures, issue arrays, and issue objects. Snapshots omit original causes and extra runtime properties. They retain application-provided issue text and provider labels. Those fields must not contain private inputs.

`EmailRouteCompatibilitySchema` and `EmailRoutePlanExplanationSchema` encode and decode the results. The explanation Schema checks that `compatible` agrees with the candidate tags.

The result describes local preparation at the time of the check. It does not reserve transport capacity or record approval, provider acceptance, or replay authority. The [route-plan example](/batching-routing#explain-a-route-plan-without-sending) shows the public imports and Layer setup.

## Validation and authority

The router preflights the effective message, key, and policy for every selected candidate before submission. If a fallback account does not support a field or key, preparation fails. The router does not remove unsupported intent.

The router can try the next account after `EmailRejected`. It stops when `reason` is `idempotency-conflict` or `unsupported-idempotency`. Unknown outcomes, terminal receipts, defects, and interruption also stop fallback.

The router rejects native-audience candidates instead of converting them to individual execution.

Routed capabilities describe support shared by the selected accounts. Native replay guarantees apply to one provider account and do not transfer between routes.

## Instrumented accounts

`observedEmailRouterLayer` and `capturedEmailRouterLayer` expose named account views for [aggregation](/composition/aggregation). The views do not provide atomic samples or retain route selection across process restarts.

The application must persist the selected account for recovery. The [account routing guide](/batching-routing#route-explicit-accounts) covers Layer setup and recovery constraints.
