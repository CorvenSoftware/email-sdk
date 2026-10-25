# @corvencore/email-sdk

## 0.2.0

### Minor Changes

- a53d981: Add direct Effect calls on `Email` and `EmailRouter`. Add `emailLayerFromSender` for sender Layers. Keep existing yielded services, typed errors, and resource scopes.
- de19275: Add opt-in account-local sender admission pacing with monotonic timing, cancellation, post-wait validation, and existing retry/deadline ownership.
- e6c66c3: Add strict Resend native batches with positional acknowledgement evidence and batch-wide keys, without automatic retries, splitting, or fallback. Preserve compound defects and interruption at shared HTTP boundaries.
- ce8d576: Add `explainEmailRoutePlan` to check each account without sending. Return ordered results and copy only modeled failure fields. Omit original error causes. Preserve defects and interruption.
- 7d48a14: Add ordered, bounded email streaming with per-item submission results, consumption-time ownership, and preserved upstream failures and interruption.

### Patch Changes

- 63057ac: Infer registered literal route names for default plans while preserving dynamic configuration, explicit legacy generics, and heterogeneous Layer errors and requirements.
