import { Effect } from "effect";
import type { Result } from "effect";
import type { EmailSendError } from "./email-errors.js";
import type { EmailReceipt } from "./email-message.js";
import { protectEmailUnsettledCause } from "./email-unsettled-cause.js";

export const settleEmailObservation = <E extends EmailSendError, Observation>(settlement: {
  readonly starting: () => Effect.Effect<void>;
  readonly submit: () => Effect.Effect<EmailReceipt, E>;
  readonly retain: (outcome: Result.Result<EmailReceipt, E>) => Effect.Effect<Observation>;
  readonly observe: (observation: Observation) => Effect.Effect<void>;
}): Effect.Effect<EmailReceipt, E> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* settleObservedEmailOutcome() {
      yield* restore(Effect.suspend(settlement.starting));

      const outcome = yield* restore(settlement.submit()).pipe(
        protectEmailUnsettledCause,
        Effect.result,
      );

      const observation = yield* settlement.retain(outcome);

      return yield* Effect.fromResult(outcome).pipe(
        Effect.onExit(() => restore(settlement.observe(observation))),
      );
    }),
  ).pipe(protectEmailUnsettledCause);
