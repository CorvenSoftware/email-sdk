import { Cause, Effect, Result } from "effect";
import type { Duration } from "effect";

export const protectEmailUnsettledCause = <A, E, R>(
  operation: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  operation.pipe(
    Effect.catchCause((cause) => {
      if (cause.reasons.length <= 1 || !Cause.hasFails(cause)) {
        return Effect.failCause(cause);
      }

      const unmodeled = cause.reasons.filter(
        (reason) => Cause.isDieReason(reason) || Cause.isInterruptReason(reason),
      );

      return Effect.failCause(Cause.combine(Cause.fromReasons(unmodeled), Cause.die(cause)));
    }),
  );

export const withEmailSubmissionDeadline = <E2>(options: {
  readonly duration: Duration.Input;
  readonly orElse: () => Effect.Effect<never, E2>;
}) =>
  <A, E, R>(operation: Effect.Effect<A, E, R>): Effect.Effect<A, E | E2, R> =>
    Effect.suspend(() => {
      let unsettled: Cause.Cause<E> | undefined;

      return operation.pipe(
        Effect.onError((cause) =>
          Effect.sync(() => {
            unsettled = cause;
          }),
        ),
        Effect.timeoutOrElse(options),
        Effect.onInterrupt(() =>
          unsettled !== undefined && Cause.hasDies(unsettled)
            ? Effect.failCause(unsettled)
            : Effect.void,
        ),
      );
    });

export const settleEmailCallbackResult = <A, E, R>(
  result: Result.Result<A, E>,
  notification: Effect.Effect<void, never, R>,
): Effect.Effect<A, E, R> =>
  notification.pipe(
    Effect.catchCause((cause) =>
      Effect.failCause(
        Result.isFailure(result) ? Cause.combine(Cause.fail(result.failure), cause) : cause,
      ),
    ),
    Effect.andThen(Effect.fromResult(result)),
    protectEmailUnsettledCause,
  );
