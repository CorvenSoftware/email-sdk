---
title: Deadlines and cancellation
description: Bound logical operations while preserving uncertainty, interruption and resource ownership.
---

A deadline limits how long the SDK owns an operation. It cannot recall an email already accepted by a provider or prove that an interrupted request was not submitted.

## Delivery deadlines

A delivery policy supplies `deadline`, `initialDelay` and `maxAttempts`. The deadline includes the provider's retry sequence. A routed operation has one overall budget rather than a fresh budget for each fallback account.

When a submission deadline leaves the outcome unresolved, preserve `EmailDeliveryUnknown`. An attempt count of one avoids repeated attempts but still cannot guarantee non-submission after a timeout.

## Caller interruption

Defects and interruption remain Effect causes. Batch operations cancel active work and propagate them rather than converting them into ordinary failed-item Results. Earlier accepted batch items remain accepted.

Provide the same cancellation semantics through custom transports and AI runners. A callback failure or interruption must not become a reason to try another account.

## Native work has physical limits

Interrupting a Blob attachment read or React render stops awaiting its result. Native work can continue after that interruption. Do not equate an interrupted wait with physical cancellation, secure erasure or absence of side effects.

Prepared operations and AI tools depend on their acquiring scope. Keep it open for the full execution, then release it at the owning application boundary. See [AI tools](/integrations/ai) and [React rendering](/integrations/react).
