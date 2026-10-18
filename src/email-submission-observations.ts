import { Context, Effect, Layer, Match, Ref, Result, Schema } from "effect";
import type { Scope } from "effect";
import { acquireEmailExtension } from "./email-extension.js";
import type { EmailExtension } from "./email-extension.js";
import { EmailConfigurationError } from "./email-configuration-error.js";
import { emailInputIssues } from "./email-input-issues.js";
import {
  EmailSubmissionObservations,
  EmailSubmissionObservationSchema,
} from "./email-submission-observation-view.js";
import type {
  EmailSubmissionObservation,
  EmailSubmissionObserver,
  EmailSubmissionObservationSnapshot,
} from "./email-submission-observation-view.js";

import type { EmailSubmissionError } from "./email-errors.js";
import type { EmailReceipt } from "./email-message.js";
import { EmailSender } from "./email-sender.js";
import type { EmailSubmission } from "./email-sender.js";
import { settleEmailObservation } from "./email-observation-settlement.js";
import { emailOperationSpan } from "./email-tracing.js";
import {
  EmailObservationOptionsSchema,
  appendEmailObservation,
} from "./email-observation-retention.js";
import type { EmailObservationOptions } from "./email-observation-retention.js";

export {
  EmailSubmissionObservations,
  EmailSubmissionObservationSchema,
  EmailSubmissionObservationSnapshotSchema,
} from "./email-submission-observation-view.js";

export type {
  IEmailSubmissionObservations,
  EmailSubmissionObservation,
  EmailSubmissionObserver,
  EmailSubmissionObservationSnapshot,
} from "./email-submission-observation-view.js";

export {
  aggregatedEmailObservationsLayer,
  EmailObservationAggregate,
  EmailObservationAggregateError,
  EmailObservationAggregateSnapshotSchema,
  EmailObservationAggregateSourceSchema,
  EmailObservationSourceNameSchema,
} from "./email-observation-aggregate.js";

export type {
  IEmailObservationAggregate,
  EmailObservationBinding,
  EmailObservationAggregateSnapshot,
  EmailObservationAggregateSource,
  EmailObservationSourceName,
} from "./email-observation-aggregate.js";

export const EmailSubmissionStartingSchema = Schema.TaggedStruct("SubmissionStarting", {
  provider: Schema.String,
});

export type EmailSubmissionStarting = typeof EmailSubmissionStartingSchema.Type;

export type EmailSubmissionStartingObserver = (
  fact: EmailSubmissionStarting,
) => Effect.Effect<void>;

export { EmailObservationOptionsSchema } from "./email-observation-retention.js";

export type { EmailObservationOptions } from "./email-observation-retention.js";

const parseObservationOptions = Schema.decodeEffect(EmailObservationOptionsSchema, {
  onExcessProperty: "error",
});

const emailSubmissionObservation = (
  outcome: Result.Result<EmailReceipt, EmailSubmissionError>,
  provider: string,
): EmailSubmissionObservation =>
  Object.freeze(
    Result.match(outcome, {
      onFailure: (failure) =>
        Match.value(failure).pipe(
          Match.tag("EmailRejected", () =>
            EmailSubmissionObservationSchema.cases.Rejected.make({ provider }),
          ),
          Match.tag("EmailDeliveryUnknown", () =>
            EmailSubmissionObservationSchema.cases.Unknown.make({ provider }),
          ),
          Match.exhaustive,
        ),
      onSuccess: (receipt) =>
        EmailSubmissionObservationSchema.cases.Receipt.make({
          provider,
          receiptKind: receipt._tag,
        }),
    }),
  );

export const observedEmailSenderLayer = <E, R, EO = never, RO = never, ES = never, RS = never>(
  senderLayer: Layer.Layer<EmailSender, E, R>,
  options: EmailObservationOptions = {},
  observer: EmailExtension<EmailSubmissionObserver, EO, RO> = () => Effect.void,
  startingObserver: EmailExtension<EmailSubmissionStartingObserver, ES, RS> = () => Effect.void,
): Layer.Layer<
  EmailSender | EmailSubmissionObservations,
  E | EO | ES | EmailConfigurationError,
  | R
  | Exclude<Exclude<RO, Scope.Scope>, EmailSender>
  | Exclude<Exclude<RS, Scope.Scope>, EmailSender>
> =>
  Layer.unwrap(
    Effect.gen(function* configureEmailSubmissionObservations() {
      const parsed = yield* parseObservationOptions(options).pipe(
        Effect.mapError(
          (cause) => new EmailConfigurationError({ issues: emailInputIssues(cause) }),
        ),
      );

      const capacity = parsed.capacity ?? 100;

      return Layer.effectContext(
        Effect.gen(function* acquireEmailSubmissionObservations() {
          const sender = yield* EmailSender;
          const observe = yield* acquireEmailExtension(observer);
          const observeStarting = yield* acquireEmailExtension(startingObserver);
          const { provider } = sender;
          const starting = Object.freeze(EmailSubmissionStartingSchema.make({ provider }));

          const observations = yield* Ref.make<EmailSubmissionObservationSnapshot>(
            Object.freeze({ observations: Object.freeze([]), truncated: false }),
          );

          const submit = Effect.fnUntraced(function* observeEmailSubmission(
            submission: EmailSubmission,
          ): Effect.fn.Return<EmailReceipt, EmailSubmissionError> {
            return yield* settleEmailObservation({
              observe: (observation: EmailSubmissionObservation) =>
                Effect.suspend(() => observe(observation)),
              retain: (outcome) => {
                const observation = emailSubmissionObservation(outcome, provider);

                return Ref.update(observations, (current) =>
                  appendEmailObservation(current, observation, capacity),
                ).pipe(Effect.as(observation));
              },
              starting: () => observeStarting(starting),
              submit: () => sender.submit(submission),
            });
          }, emailOperationSpan("ObservedEmailSender.submit"));

          return Context.make(
            EmailSender,
            EmailSender.of({
              capabilities: sender.capabilities,
              idempotency: sender.idempotency,
              provider,
              submit,
              validate: (message) => sender.validate(message),
            }),
          ).pipe(
            Context.add(
              EmailSubmissionObservations,
              EmailSubmissionObservations.of({
                snapshot: Ref.get(observations).pipe(
                  emailOperationSpan("EmailSubmissionObservations.snapshot"),
                ),
              }),
            ),
          );
        }),
      ).pipe(Layer.provide(senderLayer));
    }),
  );
