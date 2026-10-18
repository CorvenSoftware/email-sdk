import { Duration, Effect, Match, Schema } from "effect";
import { EmailDeliveryUnknown } from "./email-delivery-unknown.js";
import type { EmailSubmissionError } from "./email-errors.js";
import { EmailRejected } from "./email-rejected.js";
import { protectEmailUnsettledCause } from "./email-unsettled-cause.js";

const emailRetryDecisionFields = {
  attempt: Schema.Int.check(Schema.isBetween({ maximum: 5, minimum: 1 })),
  delayMillis: Schema.Union([
    Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
    Schema.Literal("Infinite"),
  ]),
  nextAttempt: Schema.Int.check(Schema.isBetween({ maximum: 6, minimum: 2 })),
  provider: Schema.String,
};

const consecutiveEmailRetryAttempts = Schema.makeFilter(
  (retry: { readonly attempt: number; readonly nextAttempt: number }) =>
    retry.nextAttempt === retry.attempt + 1,
  { expected: "the next consecutive submission attempt" },
);

export const EmailRetryDecisionSchema = Schema.TaggedUnion({
  RejectedRetry: { ...emailRetryDecisionFields, reason: EmailRejected.fields.reason },
  UnknownRetry: { ...emailRetryDecisionFields, reason: EmailDeliveryUnknown.fields.reason },
}).check(consecutiveEmailRetryAttempts);

export const EmailRetryCandidateSchema = Schema.TaggedUnion({
  RejectedRetryCandidate: { ...emailRetryDecisionFields, reason: EmailRejected.fields.reason },
  UnknownRetryCandidate: {
    ...emailRetryDecisionFields,
    reason: EmailDeliveryUnknown.fields.reason,
  },
}).check(consecutiveEmailRetryAttempts);

export type EmailRetryCandidate = typeof EmailRetryCandidateSchema.Type;

export type EmailRetryDecision = typeof EmailRetryDecisionSchema.Type;

export type EmailRetryObserver = (decision: EmailRetryDecision) => Effect.Effect<void>;

export type EmailRetryRestriction = (candidate: EmailRetryCandidate) => Effect.Effect<boolean>;

export const approveEmailRetryDecision = Effect.fnUntraced(function* approveEmailRetryDecision(
  failure: EmailSubmissionError,
  provider: string,
  attempt: number,
  duration: Duration.Duration,
  observer: EmailRetryObserver | undefined,
  restriction?: EmailRetryRestriction,
): Effect.fn.Return<boolean> {
  const delayMillis = Duration.toMillis(duration);

  const fields = {
    attempt,
    delayMillis: Number.isFinite(delayMillis) ? delayMillis : "Infinite",
    nextAttempt: attempt + 1,
    provider,
  } as const;

  const facts = Match.value(failure).pipe(
    Match.tag("EmailRejected", (rejected) => ({
      candidate: EmailRetryCandidateSchema.cases.RejectedRetryCandidate.make({
        ...fields,
        reason: rejected.reason,
      }),
      decision: EmailRetryDecisionSchema.cases.RejectedRetry.make({
        ...fields,
        reason: rejected.reason,
      }),
    })),
    Match.tag("EmailDeliveryUnknown", (uncertain) => ({
      candidate: EmailRetryCandidateSchema.cases.UnknownRetryCandidate.make({
        ...fields,
        reason: uncertain.reason,
      }),
      decision: EmailRetryDecisionSchema.cases.UnknownRetry.make({
        ...fields,
        reason: uncertain.reason,
      }),
    })),
    Match.exhaustive,
  );

  const candidate = Object.freeze(facts.candidate);
  const observation = Object.freeze(facts.decision);
  let permitted = true;
  yield* Effect.uninterruptibleMask((restore) =>
    Effect.fail(failure).pipe(
      Effect.onExit(() =>
        restore(
          Effect.gen(function* restrictAndObserveEmailRetry() {
            permitted =
              restriction === undefined
                ? true
                : yield* Effect.suspend(() => restriction(candidate));

            if (permitted && observer !== undefined) {
              yield* Effect.suspend(() => observer(observation));
            }
          }),
        ),
      ),
      protectEmailUnsettledCause,
      Effect.result,
    ),
  );

  return permitted;
});
