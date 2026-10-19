import { Context, Effect, Layer, Match, Option, Ref, Result, Schema, Struct } from "effect";
import type { Scope } from "effect";
import { acquireEmailExtension } from "./email-extension.js";
import type { EmailExtension } from "./email-extension.js";
import { EmailConfigurationError } from "./email-configuration-error.js";
import type { EmailSendError } from "./email-errors.js";
import { emailInputIssues } from "./email-input-issues.js";
import { EmailReceiptSchema } from "./email-message.js";
import type { EmailReceipt } from "./email-message.js";
import { emailNativeOperations, prepareEmailNativeOperation } from "./email-native-operations.js";
import type { EmailNativeOperations } from "./email-native-operations.js";
import {
  appendEmailObservation,
  EmailObservationOptionsSchema,
} from "./email-observation-retention.js";
import type { EmailObservationOptions } from "./email-observation-retention.js";
import { settleEmailObservation } from "./email-observation-settlement.js";
import { emailOperationSpan } from "./email-tracing.js";
import type { EmailPolicyOptionsSchema as EmailSendOptionsSchema } from "./email-preparation.js";
import { IterableCampaignEmail } from "./iterable-campaign-email.js";
import { IterableCampaignJobSchema, ownIterableJob } from "./iterable-campaign-job.js";
import { LoopsTransactionalEmail } from "./loops-transactional-email.js";
import { LoopsTransactionalJobSchema, ownLoopsJob } from "./loops-transactional-job.js";

const EmailNativeOperation = Schema.Literals(["LoopsTransactional", "IterableCampaign"]);

export const EmailNativeOperationStartingSchema = Schema.TaggedStruct("NativeOperationStarting", {
  operation: EmailNativeOperation,
});

export type EmailNativeOperationStarting = typeof EmailNativeOperationStartingSchema.Type;

export type EmailNativeStartingObserver = (
  fact: EmailNativeOperationStarting,
) => Effect.Effect<void>;

export const EmailNativeObservationSchema = Schema.TaggedUnion({
  Receipt: {
    operation: EmailNativeOperation,
    receiptKind: Schema.Literals(Struct.keys(EmailReceiptSchema.cases)),
  },
  Rejected: { operation: EmailNativeOperation },
  Unknown: { operation: EmailNativeOperation },
});

export type EmailNativeObservation = typeof EmailNativeObservationSchema.Type;

export type EmailNativeObserver = (observation: EmailNativeObservation) => Effect.Effect<void>;

export const EmailNativeObservationSnapshotSchema = Schema.Struct({
  observations: Schema.Array(EmailNativeObservationSchema),
  truncated: Schema.Boolean,
});

export type EmailNativeObservationSnapshot = typeof EmailNativeObservationSnapshotSchema.Type;

export interface IEmailNativeObservations {
  readonly snapshot: Effect.Effect<EmailNativeObservationSnapshot>;
}

export class EmailNativeObservations extends Context.Service<
  EmailNativeObservations,
  IEmailNativeObservations
>()("@corvencore/email-sdk/EmailNativeObservations") {}

export { EmailObservationOptionsSchema } from "./email-observation-retention.js";

export type { EmailObservationOptions } from "./email-observation-retention.js";

const parseObservationOptions = Schema.decodeEffect(EmailObservationOptionsSchema, {
  onExcessProperty: "error",
});

const emailNativeObservation = (
  outcome: Result.Result<EmailReceipt, EmailSendError>,
  operation: typeof EmailNativeOperation.Type,
): Option.Option<EmailNativeObservation> =>
  Result.match(outcome, {
    onFailure: (failure) =>
      Match.value(failure).pipe(
        Match.tag("EmailInvalidMessage", "EmailInvalidOptions", () => Option.none()),
        Match.tag("EmailRejected", () =>
          Option.some(
            Object.freeze(EmailNativeObservationSchema.cases.Rejected.make({ operation })),
          ),
        ),
        Match.tag("EmailDeliveryUnknown", () =>
          Option.some(
            Object.freeze(EmailNativeObservationSchema.cases.Unknown.make({ operation })),
          ),
        ),
        Match.exhaustive,
      ),
    onSuccess: (receipt) =>
      Option.some(
        Object.freeze(
          EmailNativeObservationSchema.cases.Receipt.make({ operation, receiptKind: receipt._tag }),
        ),
      ),
  });

const acquireNativeObservationView = Effect.fnUntraced(function* acquireNativeObservationView(
  capacity: number,
) {
  const state = yield* Ref.make<EmailNativeObservationSnapshot>(
    Object.freeze({ observations: Object.freeze([]), truncated: false }),
  );

  const record = (
    outcome: Result.Result<EmailReceipt, EmailSendError>,
    operation: typeof EmailNativeOperation.Type,
  ) =>
    Option.match(emailNativeObservation(outcome, operation), {
      onNone: () => Effect.succeed(Option.none<EmailNativeObservation>()),
      onSome: (observation) =>
        Ref.update(state, (current) => appendEmailObservation(current, observation, capacity)).pipe(
          Effect.as(Option.some(observation)),
        ),
    });

  const view = EmailNativeObservations.of({
    snapshot: Ref.get(state).pipe(emailOperationSpan("EmailNativeObservations.snapshot")),
  });

  return { record, view };
});

const observedNativeOperations = <Input, Job extends Input>(
  native: EmailNativeOperations<Job, Input>,
  jobSchema: Schema.Codec<Job, Input>,
  ownJob: (job: Job) => Job,
  operation: typeof EmailNativeOperation.Type,
  record: (
    outcome: Result.Result<EmailReceipt, EmailSendError>,
    operation: typeof EmailNativeOperation.Type,
  ) => Effect.Effect<Option.Option<EmailNativeObservation>>,
  spans: { readonly validate: string; readonly send: string; readonly sendAll: string },
  observer: EmailNativeObserver,
  startingObserver: EmailNativeStartingObserver,
): EmailNativeOperations<Job, Input> => {
  const starting = Object.freeze(EmailNativeOperationStartingSchema.make({ operation }));

  const prepare = (job: Job, options: typeof EmailSendOptionsSchema.Type) =>
    prepareEmailNativeOperation(native, ownJob, job, options);

  return emailNativeOperations({
    jobOf: (prepared) => prepared.preview,
    jobSchema,
    prepare,
    spans,
    submit: (prepared) =>
      settleEmailObservation({
        observe: (observation: Option.Option<EmailNativeObservation>) =>
          Option.match(observation, {
            onNone: () => Effect.void,
            onSome: (fact) => Effect.suspend(() => observer(fact)),
          }),
        retain: (outcome) => record(outcome, operation),
        starting: () => startingObserver(starting),
        submit: () => Effect.suspend(() => native.send(prepared.job, prepared.options)),
      }),
  });
};

export const observedLoopsTransactionalLayer = <
  E,
  R,
  EO = never,
  RO = never,
  ES = never,
  RS = never,
>(
  loopsLayer: Layer.Layer<LoopsTransactionalEmail, E, R>,
  options: EmailObservationOptions = {},
  observer: EmailExtension<EmailNativeObserver, EO, RO> = () => Effect.void,
  startingObserver: EmailExtension<EmailNativeStartingObserver, ES, RS> = () => Effect.void,
): Layer.Layer<
  LoopsTransactionalEmail | EmailNativeObservations,
  E | EO | ES | EmailConfigurationError,
  | R
  | Exclude<Exclude<RO, Scope.Scope>, LoopsTransactionalEmail>
  | Exclude<Exclude<RS, Scope.Scope>, LoopsTransactionalEmail>
> =>
  Layer.unwrap(
    Effect.gen(function* configureObservedLoopsOperations() {
      const parsed = yield* parseObservationOptions(options).pipe(
        Effect.mapError(
          (cause) => new EmailConfigurationError({ issues: emailInputIssues(cause) }),
        ),
      );

      const capacity = parsed.capacity ?? 100;

      return Layer.effectContext(
        Effect.gen(function* acquireObservedLoopsOperations() {
          const loops = yield* LoopsTransactionalEmail;
          const observe = yield* acquireEmailExtension(observer);
          const observeStarting = yield* acquireEmailExtension(startingObserver);
          const { record, view } = yield* acquireNativeObservationView(capacity);

          const operations = observedNativeOperations(
            loops,
            LoopsTransactionalJobSchema,
            ownLoopsJob,
            "LoopsTransactional",
            record,
            {
              send: "ObservedLoopsTransactionalEmail.send",
              sendAll: "ObservedLoopsTransactionalEmail.sendAll",
              validate: "ObservedLoopsTransactionalEmail.validate",
            },
            observe,
            observeStarting,
          );

          return Context.make(
            LoopsTransactionalEmail,
            LoopsTransactionalEmail.of({ ...operations, idempotency: loops.idempotency }),
          ).pipe(Context.add(EmailNativeObservations, view));
        }),
      ).pipe(Layer.provide(loopsLayer));
    }),
  );

export const observedIterableCampaignLayer = <E, R, EO = never, RO = never, ES = never, RS = never>(
  iterableLayer: Layer.Layer<IterableCampaignEmail, E, R>,
  options: EmailObservationOptions = {},
  observer: EmailExtension<EmailNativeObserver, EO, RO> = () => Effect.void,
  startingObserver: EmailExtension<EmailNativeStartingObserver, ES, RS> = () => Effect.void,
): Layer.Layer<
  IterableCampaignEmail | EmailNativeObservations,
  E | EO | ES | EmailConfigurationError,
  | R
  | Exclude<Exclude<RO, Scope.Scope>, IterableCampaignEmail>
  | Exclude<Exclude<RS, Scope.Scope>, IterableCampaignEmail>
> =>
  Layer.unwrap(
    Effect.gen(function* configureObservedIterableOperations() {
      const parsed = yield* parseObservationOptions(options).pipe(
        Effect.mapError(
          (cause) => new EmailConfigurationError({ issues: emailInputIssues(cause) }),
        ),
      );

      const capacity = parsed.capacity ?? 100;

      return Layer.effectContext(
        Effect.gen(function* acquireObservedIterableOperations() {
          const iterable = yield* IterableCampaignEmail;
          const observe = yield* acquireEmailExtension(observer);
          const observeStarting = yield* acquireEmailExtension(startingObserver);
          const { record, view } = yield* acquireNativeObservationView(capacity);

          const operations = observedNativeOperations(
            iterable,
            IterableCampaignJobSchema,
            ownIterableJob,
            "IterableCampaign",
            record,
            {
              send: "ObservedIterableCampaignEmail.send",
              sendAll: "ObservedIterableCampaignEmail.sendAll",
              validate: "ObservedIterableCampaignEmail.validate",
            },
            observe,
            observeStarting,
          );

          return Context.make(
            IterableCampaignEmail,
            IterableCampaignEmail.of({ ...operations, idempotency: iterable.idempotency }),
          ).pipe(Context.add(EmailNativeObservations, view));
        }),
      ).pipe(Layer.provide(iterableLayer));
    }),
  );
