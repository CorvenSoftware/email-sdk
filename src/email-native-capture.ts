import type { Exit } from "effect";
import { Context, Effect, Layer, Option, Ref, Result, Schema } from "effect";
import { encodeEmailCaptureOutcome } from "./email-capture-outcome.js";
import {
  EmailCaptureOptionsSchema,
  EmailCaptureOutcomeSchema,
  appendEmailCapture,
  closeEmailCapture,
  markEmailCaptureGap,
  purgeEmailCapture,
} from "./email-capture-retention.js";
import type { EmailCaptureOptions, EmailCaptureSnapshot } from "./email-capture-retention.js";
import { EmailConfigurationError } from "./email-configuration-error.js";
import type { EmailSendError } from "./email-errors.js";
import { emailInputIssues } from "./email-input-issues.js";
import type { EmailReceipt } from "./email-message.js";
import { emailNativeOperations, prepareEmailNativeOperation } from "./email-native-operations.js";
import type { EmailNativeOperations } from "./email-native-operations.js";
import { EmailPolicyOptionsSchema as EmailSendOptionsSchema } from "./email-preparation.js";
import { emailOperationSpan } from "./email-tracing.js";
import { IterableCampaignEmail } from "./iterable-campaign-email.js";
import { IterableCampaignJobSchema, ownIterableJob } from "./iterable-campaign-job.js";
import { LoopsTransactionalEmail } from "./loops-transactional-email.js";
import { LoopsTransactionalJobSchema, ownLoopsJob } from "./loops-transactional-job.js";

export {
  EmailCaptureOptionsSchema,
  EmailCaptureOutcomeSchema,
  EmailCaptureRecordSchema,
  EmailCaptureSnapshotSchema,
} from "./email-capture-retention.js";

export type {
  EmailCaptureOptions,
  EmailCaptureRecord,
  EmailCaptureSnapshot,
} from "./email-capture-retention.js";

const CapturedNativeOptions = Schema.toCodecJson(EmailSendOptionsSchema);

export const EmailNativeCaptureRequestSchema = Schema.TaggedUnion({
  IterableCampaign: { job: IterableCampaignJobSchema, options: CapturedNativeOptions },
  LoopsTransactional: { job: LoopsTransactionalJobSchema, options: CapturedNativeOptions },
});

export const EmailNativeCapturePayloadSchema = Schema.Struct({
  outcome: EmailCaptureOutcomeSchema,
  request: EmailNativeCaptureRequestSchema,
});

export type EmailNativeCapturePayload = typeof EmailNativeCapturePayloadSchema.Type;

export interface IEmailNativeCapture {
  readonly snapshot: Effect.Effect<EmailCaptureSnapshot>;
  readonly purgeRecords: Effect.Effect<number>;
}

export class EmailNativeCapture extends Context.Service<EmailNativeCapture, IEmailNativeCapture>()(
  "@corven/email-sdk/EmailNativeCapture",
) {}

const parseCaptureOptions = Schema.decodeEffect(EmailCaptureOptionsSchema, {
  onExcessProperty: "error",
});

const encodeLoopsRequest = Schema.encodeEffect(
  Schema.fromJsonString(EmailNativeCaptureRequestSchema.cases.LoopsTransactional),
);

const encodeIterableRequest = Schema.encodeEffect(
  Schema.fromJsonString(EmailNativeCaptureRequestSchema.cases.IterableCampaign),
);

const acquireNativeCapture = Effect.fnUntraced(function* acquireNativeCapture(
  options: EmailCaptureOptions,
) {
  const captured = yield* Ref.make<EmailCaptureSnapshot>(
    Object.freeze({
      closed: false,
      records: Object.freeze([]),
      retainedBytes: 0,
      truncated: false,
    }),
  );

  yield* Effect.addFinalizer(() => Ref.update(captured, closeEmailCapture));

  const retain = Effect.fnUntraced(function* retainNativeCapture(
    requestJson: Option.Option<string>,
    exit: Exit.Exit<EmailReceipt, EmailSendError>,
  ) {
    const outcome = yield* encodeEmailCaptureOutcome(exit).pipe(Effect.result);

    if (Result.isFailure(outcome)) {
      return yield* Ref.update(captured, markEmailCaptureGap);
    }

    if (Option.isNone(outcome.success)) {
      return yield* Effect.void;
    }

    if (Option.isNone(requestJson)) {
      return yield* Ref.update(captured, markEmailCaptureGap);
    }

    const payloadJson = `{"outcome":${outcome.success.value},"request":${requestJson.value}}`;

    return yield* Ref.update(captured, (current) =>
      appendEmailCapture(current, payloadJson, options),
    );
  });

  const view = EmailNativeCapture.of({
    purgeRecords: Ref.modify(captured, purgeEmailCapture).pipe(
      emailOperationSpan("EmailNativeCapture.purgeRecords"),
    ),
    snapshot: Ref.get(captured).pipe(emailOperationSpan("EmailNativeCapture.snapshot")),
  });

  return { closed: Ref.get(captured).pipe(Effect.map((current) => current.closed)), retain, view };
});

const capturedNativeOperations = <Input, Job extends Input>(
  native: EmailNativeOperations<Job, Input>,
  jobSchema: Schema.Codec<Job, Input>,
  ownJob: (job: Job) => Job,
  capture: Effect.Success<ReturnType<typeof acquireNativeCapture>>,
  encodeRequest: (
    job: Job,
    options: typeof EmailSendOptionsSchema.Type,
  ) => Effect.Effect<string, Schema.SchemaError>,
  spans: { readonly validate: string; readonly send: string; readonly sendAll: string },
): EmailNativeOperations<Job, Input> => {
  const prepare = (job: Job, options: typeof EmailSendOptionsSchema.Type) =>
    prepareEmailNativeOperation(native, ownJob, job, options);

  return emailNativeOperations({
    jobOf: (prepared) => prepared.preview,
    jobSchema,
    prepare,
    spans,
    submit: (prepared) =>
      Effect.gen(function* captureNativeSubmission() {
        if (yield* capture.closed) {
          return yield* native.send(prepared.job, prepared.options);
        }

        return yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* settleCapturedNativeSubmission() {
            const requestJson = yield* encodeRequest(prepared.job, prepared.options).pipe(
              Effect.option,
            );

            return yield* restore(
              Effect.suspend(() => native.send(prepared.job, prepared.options)),
            ).pipe(Effect.onExit((exit) => capture.retain(requestJson, exit)));
          }),
        );
      }),
  });
};

export const capturedLoopsTransactionalLayer = <E, R>(
  loopsLayer: Layer.Layer<LoopsTransactionalEmail, E, R>,
  options: EmailCaptureOptions,
): Layer.Layer<LoopsTransactionalEmail | EmailNativeCapture, E | EmailConfigurationError, R> =>
  Layer.unwrap(
    Effect.gen(function* configureCapturedLoops() {
      const parsed = yield* parseCaptureOptions(options).pipe(
        Effect.mapError(
          (cause) => new EmailConfigurationError({ issues: emailInputIssues(cause) }),
        ),
      );

      const ownedOptions = Object.freeze({ ...parsed });

      return Layer.effectContext(
        Effect.gen(function* acquireCapturedLoops() {
          const loops = yield* LoopsTransactionalEmail;
          const capture = yield* acquireNativeCapture(ownedOptions);

          const operations = capturedNativeOperations(
            loops,
            LoopsTransactionalJobSchema,
            ownLoopsJob,
            capture,
            (job, sendOptions) =>
              encodeLoopsRequest(
                EmailNativeCaptureRequestSchema.cases.LoopsTransactional.make({
                  job,
                  options: sendOptions,
                }),
              ),
            {
              send: "CapturedLoopsTransactionalEmail.send",
              sendAll: "CapturedLoopsTransactionalEmail.sendAll",
              validate: "CapturedLoopsTransactionalEmail.validate",
            },
          );

          return Context.make(
            LoopsTransactionalEmail,
            LoopsTransactionalEmail.of({ ...operations, idempotency: loops.idempotency }),
          ).pipe(Context.add(EmailNativeCapture, capture.view));
        }),
      ).pipe(Layer.provide(loopsLayer));
    }),
  );

export const capturedIterableCampaignLayer = <E, R>(
  iterableLayer: Layer.Layer<IterableCampaignEmail, E, R>,
  options: EmailCaptureOptions,
): Layer.Layer<IterableCampaignEmail | EmailNativeCapture, E | EmailConfigurationError, R> =>
  Layer.unwrap(
    Effect.gen(function* configureCapturedIterable() {
      const parsed = yield* parseCaptureOptions(options).pipe(
        Effect.mapError(
          (cause) => new EmailConfigurationError({ issues: emailInputIssues(cause) }),
        ),
      );

      const ownedOptions = Object.freeze({ ...parsed });

      return Layer.effectContext(
        Effect.gen(function* acquireCapturedIterable() {
          const iterable = yield* IterableCampaignEmail;
          const capture = yield* acquireNativeCapture(ownedOptions);

          const operations = capturedNativeOperations(
            iterable,
            IterableCampaignJobSchema,
            ownIterableJob,
            capture,
            (job, sendOptions) =>
              encodeIterableRequest(
                EmailNativeCaptureRequestSchema.cases.IterableCampaign.make({
                  job,
                  options: sendOptions,
                }),
              ),
            {
              send: "CapturedIterableCampaignEmail.send",
              sendAll: "CapturedIterableCampaignEmail.sendAll",
              validate: "CapturedIterableCampaignEmail.validate",
            },
          );

          return Context.make(
            IterableCampaignEmail,
            IterableCampaignEmail.of({ ...operations, idempotency: iterable.idempotency }),
          ).pipe(Context.add(EmailNativeCapture, capture.view));
        }),
      ).pipe(Layer.provide(iterableLayer));
    }),
  );
