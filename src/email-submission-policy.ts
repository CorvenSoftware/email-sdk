import { Duration, Effect, Match, Option, Ref, Schedule, Schema } from "effect";
import { protectEmailUnsettledCause } from "./email-unsettled-cause.js";
import { EmailDeliveryUnknown } from "./email-delivery-unknown.js";
import { EmailDeliveryPolicySchema, ownEmailDeliveryPolicy } from "./email-delivery-policy.js";
import type { EmailDeliveryPolicy } from "./email-delivery-policy.js";
import type { EmailSubmissionError } from "./email-errors.js";
import type { EmailIdempotencyKey, EmailReceipt } from "./email-message.js";
import { approveEmailRetryDecision } from "./email-retry-decision.js";
import type { EmailRetryObserver, EmailRetryRestriction } from "./email-retry-decision.js";
import { EmailSenderIdempotencySchema } from "./email-sender.js";
import type { EmailSenderIdempotency, IEmailSender } from "./email-sender.js";

const defaultEmailDeliveryPolicy: EmailDeliveryPolicy = {
  deadline: Duration.seconds(30),
  initialDelay: Duration.millis(100),
  maxAttempts: 3,
};

export const parseEmailReplayPolicy = (
  idempotency: EmailSenderIdempotency,
  policy: EmailDeliveryPolicy = defaultEmailDeliveryPolicy,
): Effect.Effect<EmailDeliveryPolicy, Schema.SchemaError> =>
  Schema.decodeEffect(
    Schema.toType(EmailDeliveryPolicySchema).check(
      Schema.makeFilter(
        (candidate) =>
          candidate.maxAttempts === 1 ||
          Match.value(idempotency).pipe(
            Match.tag("None", "KeyForwarding", () => true),
            Match.tag("Native", (native) =>
              Duration.isLessThan(candidate.deadline, native.retention),
            ),
            Match.exhaustive,
          ),
        { expected: "a retry deadline shorter than the native idempotency retention window" },
      ),
    ),
    { errors: "all", onExcessProperty: "error" },
  )(policy).pipe(Effect.map(ownEmailDeliveryPolicy));

export const submitEmailWithPolicy = (
  operation: Effect.Effect<EmailReceipt, EmailSubmissionError>,
  authority: Pick<IEmailSender, "provider" | "idempotency">,
  key: EmailIdempotencyKey | undefined,
  policy: EmailDeliveryPolicy,
  observer?: EmailRetryObserver,
  restriction?: EmailRetryRestriction,
): Effect.Effect<EmailReceipt, EmailSubmissionError> => {
  const canReplay = (failure: EmailSubmissionError) =>
    Match.value(failure).pipe(
      Match.tag(
        "EmailRejected",
        (rejected) =>
          rejected.reason === "rate-limited" || rejected.reason === "temporarily-unavailable",
      ),
      Match.tag(
        "EmailDeliveryUnknown",
        (uncertain) =>
          EmailSenderIdempotencySchema.guards.Native(authority.idempotency) &&
          key !== undefined &&
          ["transport", "timeout", "server-error", "idempotency-in-progress"].includes(
            uncertain.reason,
          ),
      ),
      Match.exhaustive,
    );

  const schedule = Schedule.exponential(policy.initialDelay).pipe(
    Schedule.jittered,
    Schedule.modifyDelay(
      ({
        input,
        duration,
      }: {
        readonly duration: Duration.Duration;
        readonly input: EmailSubmissionError;
      }) =>
        Effect.succeed(
          Match.value(input).pipe(
            Match.tag("EmailRejected", (rejected) =>
              Duration.max(duration, Duration.millis(rejected.retryAfterMillis ?? 0)),
            ),
            Match.tag("EmailDeliveryUnknown", (uncertain) =>
              Duration.max(duration, Duration.millis(uncertain.retryAfterMillis ?? 0)),
            ),
            Match.exhaustive,
          ),
        ),
    ),
    Schedule.passthrough,
    Schedule.while(({ input }) => canReplay(input)),
    Schedule.upTo({ times: policy.maxAttempts - 1 }),
    Schedule.while(({ attempt, input, duration }) =>
      observer === undefined && restriction === undefined
        ? true
        : approveEmailRetryDecision(
            input,
            authority.provider,
            attempt,
            duration,
            observer,
            restriction,
          ),
    ),
  );

  return Effect.gen(function* preserveEmailSubmissionEvidence() {
    const uncertainty = yield* Ref.make<Option.Option<EmailDeliveryUnknown>>(Option.none());

    return yield* operation.pipe(
      protectEmailUnsettledCause,
      Effect.tapErrorTag("EmailDeliveryUnknown", (failure) =>
        Ref.set(uncertainty, Option.some(failure)),
      ),
      Effect.retry(schedule),
      Effect.catchTag("EmailRejected", (failure) => {
        if (failure.reason === "idempotency-conflict") {
          return Effect.fail(failure);
        }

        return Ref.get(uncertainty).pipe(
          Effect.flatMap((previous) => Effect.fail(Option.getOrElse(previous, () => failure))),
        );
      }),
      Effect.timeoutOrElse({
        duration: policy.deadline,
        orElse: () =>
          Effect.fail(
            new EmailDeliveryUnknown({ provider: authority.provider, reason: "timeout" }),
          ),
      }),
    );
  });
};
