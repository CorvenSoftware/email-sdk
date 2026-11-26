import { Context, Effect, Layer, Option, Result, Schema } from "effect";
import { encodeEmailCaptureOutcome } from "./email-capture-outcome.js";
import { EmailConfigurationError } from "./email-configuration-error.js";
import { EmailCaptureOutcomeSchema, EmailCaptureOptionsSchema } from "./email-capture-retention.js";
import type { EmailCaptureOptions } from "./email-capture-retention.js";
import { acquireEmailCaptureStore } from "./email-capture-store.js";
import type { EmailSubmissionError } from "./email-errors.js";
import { emailInputIssues } from "./email-input-issues.js";
import { EmailIdempotencyKeySchema, EmailMessageSchema } from "./email-message.js";
import type { EmailReceipt } from "./email-message.js";
import { EmailSender } from "./email-sender.js";
import type { EmailSubmission } from "./email-sender.js";
import { emailOperationSpan } from "./email-tracing.js";
import { EmailSubmissionCapture } from "./email-submission-capture-view.js";

export { EmailSubmissionCapture } from "./email-submission-capture-view.js";

export type { IEmailSubmissionCapture } from "./email-submission-capture-view.js";

export {
  EmailCaptureAggregate,
  EmailCaptureAggregateError,
  EmailCaptureAggregateSnapshotSchema,
  EmailCaptureAggregateSourceSchema,
  EmailCaptureSourceNameSchema,
  aggregatedEmailCaptureLayer,
} from "./email-capture-aggregate.js";

export type {
  IEmailCaptureAggregate,
  EmailCaptureAggregateSnapshot,
  EmailCaptureAggregateSource,
  EmailCaptureSourceName,
  EmailCaptureBinding,
} from "./email-capture-aggregate.js";

const CapturedSubmissionSchema = Schema.Struct({
  idempotencyKey: Schema.optionalKey(EmailIdempotencyKeySchema),
  message: EmailMessageSchema,
});

export {
  EmailCaptureOutcomeSchema,
  EmailCaptureOptionsSchema,
  EmailCaptureRecordSchema,
  EmailCaptureSnapshotSchema,
} from "./email-capture-retention.js";

export type {
  EmailCaptureOptions,
  EmailCaptureRecord,
  EmailCaptureSnapshot,
} from "./email-capture-retention.js";

export const EmailCapturePayloadSchema = Schema.Struct({
  outcome: EmailCaptureOutcomeSchema,
  provider: Schema.String,
  submission: CapturedSubmissionSchema,
});

export type EmailCapturePayload = typeof EmailCapturePayloadSchema.Type;

const parseCaptureOptions = Schema.decodeEffect(EmailCaptureOptionsSchema, {
  onExcessProperty: "error",
});

const encodeCapturedSubmission = Schema.encodeEffect(
  Schema.fromJsonString(CapturedSubmissionSchema),
);

export const capturedEmailSenderLayer = <E, R>(
  senderLayer: Layer.Layer<EmailSender, E, R>,
  options: EmailCaptureOptions,
): Layer.Layer<EmailSender | EmailSubmissionCapture, E | EmailConfigurationError, R> =>
  Layer.unwrap(
    Effect.gen(function* configureEmailSubmissionCapture() {
      const parsed = yield* parseCaptureOptions(options).pipe(
        Effect.mapError(
          (cause) => new EmailConfigurationError({ issues: emailInputIssues(cause) }),
        ),
      );

      const ownedOptions = Object.freeze({ ...parsed });

      return Layer.effectContext(
        Effect.gen(function* acquireEmailSubmissionCapture() {
          const sender = yield* EmailSender;
          const { provider } = sender;
          const providerJson = JSON.stringify(provider);

          const capture = yield* acquireEmailCaptureStore(ownedOptions);

          const purgeRecords = capture.purgeRecords.pipe(
            emailOperationSpan("EmailSubmissionCapture.purgeRecords"),
          );

          const submit = Effect.fnUntraced(function* captureEmailSubmission(
            submission: EmailSubmission,
          ): Effect.fn.Return<EmailReceipt, EmailSubmissionError> {
            if (yield* capture.closed) {
              return yield* sender.submit(submission);
            }

            return yield* Effect.uninterruptibleMask((restore) =>
              Effect.gen(function* settleCapturedEmailSubmission() {
                const requestJson = yield* encodeCapturedSubmission(submission).pipe(Effect.option);

                return yield* restore(Effect.suspend(() => sender.submit(submission))).pipe(
                  Effect.onExit((exit) =>
                    Effect.gen(function* retainCapturedEmailExit() {
                      if (Option.isNone(requestJson)) {
                        return yield* capture.markGap;
                      }

                      const encodedOutcome = yield* encodeEmailCaptureOutcome(exit).pipe(
                        Effect.result,
                      );

                      if (Result.isFailure(encodedOutcome)) {
                        return yield* capture.markGap;
                      }

                      if (Option.isNone(encodedOutcome.success)) {
                        return yield* Effect.void;
                      }

                      const payloadJson = `{"outcome":${encodedOutcome.success.value},"provider":${providerJson},"submission":${requestJson.value}}`;

                      return yield* capture.append(payloadJson);
                    }),
                  ),
                );
              }),
            );
          }, emailOperationSpan("CapturedEmailSender.submit"));

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
              EmailSubmissionCapture,
              EmailSubmissionCapture.of({
                purgeRecords,
                snapshot: capture.snapshot.pipe(
                  emailOperationSpan("EmailSubmissionCapture.snapshot"),
                ),
              }),
            ),
          );
        }),
      ).pipe(Layer.provide(senderLayer));
    }),
  );
