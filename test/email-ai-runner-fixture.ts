import { Cause, Effect, Exit, Queue } from "effect";
import type { EmailAiToolError, EmailAiReceipt, EmailAiRunner } from "../src/email-ai-tool.js";

type RunnerExit = Exit.Exit<EmailAiReceipt, EmailAiToolError>;

interface RunnerCall {
  readonly operation: Parameters<EmailAiRunner>[0];
  readonly signal: AbortSignal | undefined;
  readonly resolve: (value: EmailAiReceipt) => void;
  readonly reject: (error: Error) => void;
}

const awaitAbort = (signal: AbortSignal) =>
  Effect.callback<never>((resume) => {
    const abort = () => {
      resume(Effect.interrupt);
    };

    signal.addEventListener("abort", abort, { once: true });

    if (signal.aborted) {
      abort();
    }

    return Effect.sync(() => {
      signal.removeEventListener("abort", abort);
    });
  });

export const startEmailAiRunnerFixture = Effect.fnUntraced(function* startEmailAiRunnerFixture() {
  const calls = yield* Queue.unbounded<RunnerCall>();
  const exits = yield* Queue.unbounded<RunnerExit>();
  const scope = yield* Effect.scope;

  const execute = Effect.fnUntraced(function* executeEmailAiRunnerCall(call: RunnerCall) {
    const cancelled = call.signal === undefined ? Effect.never : awaitAbort(call.signal);

    const operation =
      call.signal?.aborted === true
        ? Effect.interrupt
        : Effect.raceFirst(call.operation, cancelled);

    yield* operation.pipe(
      Effect.onExit((exit) =>
        Queue.offer(exits, exit).pipe(
          Effect.andThen(
            Effect.sync(() => {
              Exit.match(exit, {
                onFailure: (cause) => {
                  const error = Cause.squash(cause);
                  call.reject(
                    error instanceof Error ? error : new Error("Email AI runner interrupted."),
                  );
                },
                onSuccess: call.resolve,
              });
            }),
          ),
        ),
      ),
      Effect.exit,
    );
  });

  yield* Queue.take(calls).pipe(
    Effect.flatMap((call) => Effect.forkIn(execute(call), scope)),
    Effect.forever,
    Effect.forkScoped,
  );

  const run: EmailAiRunner = (operation, { signal }): ReturnType<EmailAiRunner> => {
    const completion = Promise.withResolvers<EmailAiReceipt>();
    Queue.offerUnsafe(calls, {
      operation,
      reject: completion.reject,
      resolve: completion.resolve,
      signal,
    });

    return completion.promise;
  };

  return { exits, run };
});
