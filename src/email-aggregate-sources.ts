import { Array as EffectArray, Effect, Schema, Struct } from "effect";
import { EmailConfigurationError } from "./email-configuration-error.js";
import { emailInputIssues } from "./email-input-issues.js";

export const acquireEmailAggregateSources = <
  Binding extends { readonly layer: unknown },
  Registration extends object,
  View extends object,
  E,
  R,
>(
  bindings: readonly [Binding, ...Binding[]],
  registrationsSchema: Schema.Codec<
    readonly [Registration, ...Registration[]],
    readonly [Omit<Binding, "layer">, ...Omit<Binding, "layer">[]]
  >,
  acquireView: (binding: Binding) => Effect.Effect<View, E, R>,
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
        const view = yield* acquireView(binding);

        if (seen.has(view)) {
          return yield* new EmailConfigurationError({
            issues: [{ path: "sources", problem: duplicateProblem }],
          });
        }

        seen.add(view);

        return Object.freeze({ registration: Object.freeze(registration), view });
      }),
      { concurrency: 1 },
    );
  });
