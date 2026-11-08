import { Array as EffectArray, Effect, Schema, Struct } from "effect";
import { EmailConfigurationError } from "./email-configuration-error.js";
import { emailInputIssues } from "./email-input-issues.js";

export interface AcquiredEmailAggregateSource<A, E> {
  readonly view: object;
  readonly read: Effect.Effect<A, E>;
}

export const acquireEmailAggregateSources = <
  Binding extends { readonly layer: unknown },
  Registration extends object,
  A,
  ReadError,
  E,
  R,
>(
  bindings: readonly [Binding, ...Binding[]],
  registrationsSchema: Schema.Codec<
    readonly [Registration, ...Registration[]],
    readonly [Omit<Binding, "layer">, ...Omit<Binding, "layer">[]]
  >,
  acquireSource: (
    binding: Binding,
    registration: Readonly<Registration>,
  ) => Effect.Effect<AcquiredEmailAggregateSource<A, ReadError>, E, R>,
  duplicateProblem: string,
) =>
  Effect.gen(function* acquireNamedEmailViews() {
    const owned = EffectArray.map<typeof bindings, Binding>((binding) =>
      Object.freeze({ ...binding }),
    )(bindings);

    const metadata = EffectArray.map<typeof owned, Omit<Binding, "layer">>((binding) =>
      Struct.omit(binding, ["layer"]),
    )(owned);

    const registrations = yield* Schema.decodeEffect(registrationsSchema, {
      errors: "all",
      onExcessProperty: "error",
    })(metadata).pipe(
      Effect.mapError((cause) => new EmailConfigurationError({ issues: emailInputIssues(cause) })),
    );

    const seen = new Set<object>();

    return yield* Effect.forEach(
      EffectArray.zip(owned, registrations),
      Effect.fnUntraced(function* acquireNamedEmailView([binding, registration]: readonly [
        Binding,
        Registration,
      ]) {
        const source = yield* acquireSource(binding, Object.freeze(registration));

        if (seen.has(source.view)) {
          return yield* new EmailConfigurationError({
            issues: [{ path: "sources", problem: duplicateProblem }],
          });
        }

        seen.add(source.view);

        return Object.freeze(source);
      }),
      { concurrency: 1 },
    );
  });
