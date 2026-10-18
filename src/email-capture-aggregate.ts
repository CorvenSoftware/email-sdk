import { Array as EffectArray, Context, Effect, Layer, Match, Schema } from "effect";
import { acquireEmailAggregateSources } from "./email-aggregate-sources.js";
import { EmailCaptureAggregateError } from "./email-capture-aggregate-error.js";
import { EmailCaptureSnapshotSchema } from "./email-capture-retention.js";
import type { EmailCaptureSnapshot } from "./email-capture-retention.js";
import type { EmailConfigurationError } from "./email-configuration-error.js";
import { EmailNativeCapture } from "./email-native-capture.js";
import { EmailSubmissionCapture } from "./email-submission-capture-view.js";
import { emailOperationSpan } from "./email-tracing.js";

export { EmailCaptureAggregateError } from "./email-capture-aggregate-error.js";

export const EmailCaptureSourceNameSchema = Schema.String.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[a-z][a-z0-9_-]*$/u, { expected: "a lowercase opaque capture source name" }),
).pipe(Schema.brand("EmailCaptureSourceName"));

export type EmailCaptureSourceName = typeof EmailCaptureSourceNameSchema.Type;

export const EmailCaptureAggregateSourceSchema = Schema.Struct({
  name: EmailCaptureSourceNameSchema,
  snapshot: EmailCaptureSnapshotSchema,
  unit: Schema.Literals(["SenderInvocation", "NativeOperation"]),
});

export type EmailCaptureAggregateSource = typeof EmailCaptureAggregateSourceSchema.Type;

export const EmailCaptureAggregateSnapshotSchema = Schema.Struct({
  retainedBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  retainedRecords: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  sources: Schema.NonEmptyArray(EmailCaptureAggregateSourceSchema).check(Schema.isMaxLength(16)),
  truncated: Schema.Boolean,
});

export type EmailCaptureAggregateSnapshot = typeof EmailCaptureAggregateSnapshotSchema.Type;

export interface IEmailCaptureAggregate {
  readonly snapshot: Effect.Effect<EmailCaptureAggregateSnapshot, EmailCaptureAggregateError>;
}

export class EmailCaptureAggregate extends Context.Service<
  EmailCaptureAggregate,
  IEmailCaptureAggregate
>()("@corven/email-sdk/EmailCaptureAggregate") {}

export type EmailCaptureBinding<E, R> =
  | {
      readonly kind: "Submission";
      readonly name: string;
      readonly layer: Layer.Layer<EmailSubmissionCapture, E, R>;
    }
  | {
      readonly kind: "Native";
      readonly name: string;
      readonly layer: Layer.Layer<EmailNativeCapture, E, R>;
    };

const captureObservationUnits = {
  Native: "NativeOperation",
  Submission: "SenderInvocation",
} as const;

const CaptureRegistrationSchema = Schema.Struct({
  kind: Schema.Literals(["Submission", "Native"]),
  name: EmailCaptureSourceNameSchema,
});

const CaptureRegistrationsSchema = Schema.NonEmptyArray(CaptureRegistrationSchema).check(
  Schema.isMaxLength(16),
  Schema.makeFilter(
    (sources) => new Set(sources.map((source) => source.name)).size === sources.length,
    {
      expected: "distinct capture source names",
    },
  ),
);

const parseSnapshot = Schema.decodeEffect(
  Schema.toType(EmailCaptureSnapshotSchema).check(
    Schema.makeFilter(
      (snapshot) =>
        snapshot.retainedBytes ===
          snapshot.records.reduce((total, record) => total + record.byteLength, 0) &&
        (!snapshot.closed || snapshot.records.length === 0),
      { expected: "consistent capture byte counts and closed state" },
    ),
  ),
  { errors: "all", onExcessProperty: "error" },
);

const ownCaptureSnapshot = (snapshot: EmailCaptureSnapshot): EmailCaptureSnapshot =>
  Object.freeze({
    ...snapshot,
    records: Object.freeze(snapshot.records.map((record) => Object.freeze({ ...record }))),
  });

const captureAggregateLayer = <E, R>(
  bindings: readonly [EmailCaptureBinding<E, R>, ...EmailCaptureBinding<E, R>[]],
): Layer.Layer<EmailCaptureAggregate, E | EmailConfigurationError, R> =>
  Layer.fromBuildMemo((memoMap, scope) =>
    Effect.gen(function* acquireCaptureAggregate() {
      const acquired = yield* acquireEmailAggregateSources(
        bindings,
        CaptureRegistrationsSchema,
        (binding) =>
          Match.value(binding).pipe(
            Match.when({ kind: "Submission" }, (source) =>
              Layer.buildWithMemoMap(source.layer, memoMap, scope).pipe(
                Effect.map((context) => Context.get(context, EmailSubmissionCapture)),
              ),
            ),
            Match.when({ kind: "Native" }, (source) =>
              Layer.buildWithMemoMap(source.layer, memoMap, scope).pipe(
                Effect.map((context) => Context.get(context, EmailNativeCapture)),
              ),
            ),
            Match.exhaustive,
          ),
        "Capture sources must be distinct views",
      );

      const readers = EffectArray.map<
        typeof acquired,
        Effect.Effect<EmailCaptureAggregateSource, EmailCaptureAggregateError>
      >(({ view, registration }) =>
        view.snapshot.pipe(
          Effect.flatMap((snapshot) =>
            parseSnapshot(snapshot).pipe(
              Effect.mapError(() => new EmailCaptureAggregateError({ reason: "invalid-source" })),
            ),
          ),
          Effect.map((snapshot) =>
            Object.freeze({
              name: registration.name,
              snapshot: ownCaptureSnapshot(snapshot),
              unit: captureObservationUnits[registration.kind],
            }),
          ),
        ),
      )(acquired);

      const snapshot = Effect.gen(function* readCaptureAggregate() {
        const sources = yield* Effect.all(readers, { concurrency: 1 });

        return Object.freeze({
          retainedBytes: sources.reduce(
            (total, source) => total + source.snapshot.retainedBytes,
            0,
          ),
          retainedRecords: sources.reduce(
            (total, source) => total + source.snapshot.records.length,
            0,
          ),
          sources: Object.freeze(sources),
          truncated: sources.some((source) => source.snapshot.truncated),
        });
      }).pipe(emailOperationSpan("EmailCaptureAggregate.snapshot"));

      return Context.make(EmailCaptureAggregate, EmailCaptureAggregate.of({ snapshot }));
    }),
  );

export const aggregatedEmailCaptureLayer = <
  const Sources extends readonly [
    EmailCaptureBinding<unknown, unknown>,
    ...EmailCaptureBinding<unknown, unknown>[],
  ],
>(
  bindings: Sources &
    readonly [
      EmailCaptureBinding<
        Layer.Error<Sources[number]["layer"]>,
        Layer.Services<Sources[number]["layer"]>
      >,
      ...EmailCaptureBinding<
        Layer.Error<Sources[number]["layer"]>,
        Layer.Services<Sources[number]["layer"]>
      >[],
    ],
): Layer.Layer<
  EmailCaptureAggregate,
  Layer.Error<Sources[number]["layer"]> | EmailConfigurationError,
  Layer.Services<Sources[number]["layer"]>
> =>
  captureAggregateLayer<
    Layer.Error<Sources[number]["layer"]>,
    Layer.Services<Sources[number]["layer"]>
  >(bindings);
