import { Cause, Clock, Effect, Exit } from "effect";

export const emailOperationSpan =
  (name: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.gen(function* traceEmailOperation() {
      const span = yield* Effect.makeSpan(name);

      return yield* effect.pipe(
        Effect.withParentSpan(span),
        Effect.onExit((exit) =>
          Effect.gen(function* closeEmailOperationSpan() {
            const now = yield* Clock.currentTimeNanos;

            let safeExit: Exit.Exit<void, string> = Exit.void;

            if (Exit.isFailure(exit)) {
              safeExit = Cause.hasInterrupts(exit.cause)
                ? Exit.interrupt()
                : Exit.fail("email-operation-failed");
            }

            span.end(now, safeExit);
          }),
        ),
      );
    });
