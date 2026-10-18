import { Cause, Effect } from "effect";

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
