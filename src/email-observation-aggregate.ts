import { Array as EffectArray, Context, Effect, Layer, Match, Schema, Struct } from "effect";
import { acquireEmailAggregateSources } from "./email-aggregate-sources.js";
import type { EmailConfigurationError } from "./email-configuration-error.js";
import {
  EmailNativeObservations,
  EmailNativeObservationSnapshotSchema,
} from "./email-native-observations.js";
import type { EmailNativeObservationSnapshot } from "./email-native-observations.js";
import { EmailObservationAggregateError } from "./email-observation-aggregate-error.js";
import type { EmailObservationSnapshot } from "./email-observation-retention.js";
import {
  EmailSubmissionObservations,
  EmailSubmissionObservationSnapshotSchema,
} from "./email-submission-observation-view.js";
import type { EmailSubmissionObservationSnapshot } from "./email-submission-observation-view.js";
import { emailOperationSpan } from "./email-tracing.js";

export { EmailObservationAggregateError } from "./email-observation-aggregate-error.js";

export const EmailObservationSourceNameSchema = Schema.String.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[a-z][a-z0-9_-]*$/u, {
    expected: "a lowercase opaque observation source name",
  }),
).pipe(Schema.brand("EmailObservationSourceName"));

export type EmailObservationSourceName = typeof EmailObservationSourceNameSchema.Type;

export const EmailObservationAggregateSourceSchema = Schema.Union([
  Schema.Struct({
    name: EmailObservationSourceNameSchema,
    snapshot: EmailSubmissionObservationSnapshotSchema,
    unit: Schema.tag("SenderInvocation"),
  }),
  Schema.Struct({
    name: EmailObservationSourceNameSchema,
    snapshot: EmailNativeObservationSnapshotSchema,
    unit: Schema.tag("NativeOperation"),
  }),
]).pipe(Schema.toTaggedUnion("unit"));

export type EmailObservationAggregateSource = typeof EmailObservationAggregateSourceSchema.Type;

export const EmailObservationAggregateSnapshotSchema = Schema.Struct({
  retainedObservations: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  sources: Schema.NonEmptyArray(EmailObservationAggregateSourceSchema).check(
    Schema.isMaxLength(16),
  ),
  truncated: Schema.Boolean,
});

export type EmailObservationAggregateSnapshot = typeof EmailObservationAggregateSnapshotSchema.Type;

export interface IEmailObservationAggregate {
  readonly snapshot: Effect.Effect<
    EmailObservationAggregateSnapshot,
    EmailObservationAggregateError
  >;
}

export class EmailObservationAggregate extends Context.Service<
  EmailObservationAggregate,
  IEmailObservationAggregate
>()("@corvencore/email-sdk/EmailObservationAggregate") {}

export type EmailObservationBinding<E, R> =
  | {
      readonly kind: "Submission";
      readonly name: string;
      readonly layer: Layer.Layer<EmailSubmissionObservations, E, R>;
    }
  | {
      readonly kind: "Native";
      readonly name: string;
      readonly layer: Layer.Layer<EmailNativeObservations, E, R>;
    };

const ObservationRegistrationSchema = Schema.Struct({
  kind: Schema.Literals(["Submission", "Native"]),
  name: EmailObservationSourceNameSchema,
});

const ObservationRegistrationsSchema = Schema.NonEmptyArray(ObservationRegistrationSchema).check(
  Schema.isMaxLength(16),
  Schema.makeFilter(
    (sources) => new Set(sources.map((source) => source.name)).size === sources.length,
    { expected: "distinct observation source names" },
  ),
);

const parseSubmissionSnapshot = Schema.decodeUnknownEffect(
  Schema.toType(EmailSubmissionObservationSnapshotSchema),
  { errors: "all", onExcessProperty: "error" },
);

const parseNativeSnapshot = Schema.decodeUnknownEffect(
  Schema.toType(EmailNativeObservationSnapshotSchema),
  { errors: "all", onExcessProperty: "error" },
);

const ownObservationSnapshot = <Observation extends object>(
  snapshot: EmailObservationSnapshot<Observation>,
): EmailObservationSnapshot<Observation> =>
  Object.freeze({
    ...snapshot,
    observations: Object.freeze(
      snapshot.observations.map((observation) => Object.freeze({ ...observation })),
    ),
  });

const observationAggregateLayer = <E, R>(
  bindings: readonly [EmailObservationBinding<E, R>, ...EmailObservationBinding<E, R>[]],
): Layer.Layer<EmailObservationAggregate, E | EmailConfigurationError, R> =>
  Layer.fromBuildMemo((memoMap, scope) =>
    Effect.gen(function* acquireObservationAggregate() {
      const acquired = yield* acquireEmailAggregateSources(
        bindings,
        ObservationRegistrationsSchema,
        (binding) =>
          Match.value(binding).pipe(
            Match.when({ kind: "Submission" }, (source) =>
              Layer.buildWithMemoMap(source.layer, memoMap, scope).pipe(
                Effect.map((context) => Context.get(context, EmailSubmissionObservations)),
              ),
            ),
            Match.when({ kind: "Native" }, (source) =>
              Layer.buildWithMemoMap(source.layer, memoMap, scope).pipe(
                Effect.map((context) => Context.get(context, EmailNativeObservations)),
              ),
            ),
            Match.exhaustive,
          ),
        "Observation sources must be distinct views",
      );

      const readers = EffectArray.map<
        typeof acquired,
        Effect.Effect<EmailObservationAggregateSource, EmailObservationAggregateError>
      >(({ view, registration }) => {
        const sample: Effect.Effect<
          EmailSubmissionObservationSnapshot | EmailNativeObservationSnapshot
        > = view.snapshot;

        return sample.pipe(
          Effect.flatMap((snapshot) =>
            Match.value(registration.kind).pipe(
              Match.when("Submission", () =>
                parseSubmissionSnapshot(snapshot).pipe(
                  Effect.map((parsed) =>
                    Object.freeze(
                      Struct.evolve(
                        EmailObservationAggregateSourceSchema.cases.SenderInvocation.make({
                          name: registration.name,
                          snapshot: parsed,
                        }),
                        { snapshot: (retained) => ownObservationSnapshot(retained) },
                      ),
                    ),
                  ),
                ),
              ),
              Match.when("Native", () =>
                parseNativeSnapshot(snapshot).pipe(
                  Effect.map((parsed) =>
                    Object.freeze(
                      Struct.evolve(
                        EmailObservationAggregateSourceSchema.cases.NativeOperation.make({
                          name: registration.name,
                          snapshot: parsed,
                        }),
                        { snapshot: (retained) => ownObservationSnapshot(retained) },
                      ),
                    ),
                  ),
                ),
              ),
              Match.exhaustive,
            ),
          ),
          Effect.mapError(() => new EmailObservationAggregateError({ reason: "invalid-source" })),
        );
      })(acquired);

      const snapshot = Effect.gen(function* readObservationAggregate() {
        const sources = yield* Effect.all(readers, { concurrency: 1 });

        return Object.freeze({
          retainedObservations: sources.reduce(
            (total, source) => total + source.snapshot.observations.length,
            0,
          ),
          sources: Object.freeze(sources),
          truncated: sources.some((source) => source.snapshot.truncated),
        });
      }).pipe(emailOperationSpan("EmailObservationAggregate.snapshot"));

      return Context.make(EmailObservationAggregate, EmailObservationAggregate.of({ snapshot }));
    }),
  );

export const aggregatedEmailObservationsLayer = <
  const Sources extends readonly [
    EmailObservationBinding<unknown, unknown>,
    ...EmailObservationBinding<unknown, unknown>[],
  ],
>(
  bindings: Sources &
    readonly [
      EmailObservationBinding<
        Layer.Error<Sources[number]["layer"]>,
        Layer.Services<Sources[number]["layer"]>
      >,
      ...EmailObservationBinding<
        Layer.Error<Sources[number]["layer"]>,
        Layer.Services<Sources[number]["layer"]>
      >[],
    ],
): Layer.Layer<
  EmailObservationAggregate,
  Layer.Error<Sources[number]["layer"]> | EmailConfigurationError,
  Layer.Services<Sources[number]["layer"]>
> =>
  observationAggregateLayer<
    Layer.Error<Sources[number]["layer"]>,
    Layer.Services<Sources[number]["layer"]>
  >(bindings);
