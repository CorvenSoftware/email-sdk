import { Duration } from "effect";
import type { Effect, Layer } from "effect";
import { expectTypeOf } from "vitest";
import {
  capturedEmailRouterLayer,
  observedEmailRouterLayer,
} from "../src/email-account-routing.js";
import type { EmailCaptureAggregate } from "../src/email-capture-aggregate.js";
import type { EmailConfigurationError } from "../src/email-configuration-error.js";
import type { EmailInvalidOptions } from "../src/email-invalid-options.js";
import type { EmailObservationAggregate } from "../src/email-observation-aggregate.js";
import { emailRouterLayer } from "../src/email-routing.js";
import type {
  EmailRoutePlanInput,
  EmailRouter,
  IEmailRoute,
  IEmailRouter,
} from "../src/email-routing.js";
import type { Email } from "../src/email-service.js";
import type { EmailSubmissionCapture } from "../src/email-submission-capture-view.js";
import type { EmailSubmissionObservations } from "../src/email-submission-observation-view.js";

export const proveRegisteredEmailRouteInference = <E1, R1, E2, R2>(
  first: Layer.Layer<Email, E1, R1>,
  second: Layer.Layer<Email, E2, R2>,
  capturedFirst: Layer.Layer<Email | EmailSubmissionCapture, E1, R1>,
  capturedSecond: Layer.Layer<Email | EmailSubmissionCapture, E2, R2>,
  observedFirst: Layer.Layer<Email | EmailSubmissionObservations, E1, R1>,
  observedSecond: Layer.Layer<Email | EmailSubmissionObservations, E2, R2>,
  dynamicName: string,
  router: IEmailRouter,
): void => {
  const ordinary = emailRouterLayer(
    [
      { layer: first, name: "first" },
      { layer: second, name: "second" },
    ],
    { deadline: Duration.seconds(5), fallbacks: ["second"], primary: "first" },
  );

  expectTypeOf(ordinary).toEqualTypeOf<
    Layer.Layer<Email | EmailRouter, E1 | E2 | EmailConfigurationError, R1 | R2>
  >();

  const captured = capturedEmailRouterLayer(
    [
      { layer: capturedFirst, name: "first" },
      { layer: capturedSecond, name: "second" },
    ],
    { fallbacks: ["first"], primary: "second" },
  );

  expectTypeOf(captured).toEqualTypeOf<
    Layer.Layer<
      Email | EmailRouter | EmailCaptureAggregate,
      E1 | E2 | EmailConfigurationError,
      R1 | R2
    >
  >();

  const observed = observedEmailRouterLayer(
    [
      { layer: observedFirst, name: "first" },
      { layer: observedSecond, name: "second" },
    ],
    { fallbacks: ["second"], primary: "first" },
  );

  expectTypeOf(observed).toEqualTypeOf<
    Layer.Layer<
      Email | EmailRouter | EmailObservationAggregate,
      E1 | E2 | EmailConfigurationError,
      R1 | R2
    >
  >();

  // @ts-expect-error -- Only binding names may determine the default primary route.
  void emailRouterLayer([{ layer: first, name: "first" }], { primary: "typo" });
  void emailRouterLayer([{ layer: first, name: "first" }], {
    // @ts-expect-error -- Only registered literal names are accepted as fallbacks.
    fallbacks: ["typo"],
    primary: "first",
  });
  // @ts-expect-error -- Captured defaults cannot widen the binding name union.
  void capturedEmailRouterLayer([{ layer: capturedFirst, name: "first" }], { primary: "typo" });
  void capturedEmailRouterLayer([{ layer: capturedFirst, name: "first" }], {
    // @ts-expect-error -- Captured fallbacks must name registered routes.
    fallbacks: ["typo"],
    primary: "first",
  });
  // @ts-expect-error -- Observed defaults cannot widen the binding name union.
  void observedEmailRouterLayer([{ layer: observedFirst, name: "first" }], { primary: "typo" });
  void observedEmailRouterLayer([{ layer: observedFirst, name: "first" }], {
    // @ts-expect-error -- Observed fallbacks must name registered routes.
    fallbacks: ["typo"],
    primary: "first",
  });

  void emailRouterLayer([{ layer: first, name: dynamicName }], {
    fallbacks: [dynamicName],
    primary: "runtime-route",
  });
  void capturedEmailRouterLayer([{ layer: capturedFirst, name: dynamicName }], {
    fallbacks: [dynamicName],
    primary: "runtime-route",
  });
  void observedEmailRouterLayer([{ layer: observedFirst, name: dynamicName }], {
    fallbacks: [dynamicName],
    primary: "runtime-route",
  });
  void emailRouterLayer(
    [
      { layer: first, name: "first" },
      { layer: second, name: dynamicName },
    ],
    { fallbacks: ["runtime-fallback"], primary: "runtime-route" },
  );
  void capturedEmailRouterLayer(
    [
      { layer: capturedFirst, name: "first" },
      { layer: capturedSecond, name: dynamicName },
    ],
    { fallbacks: ["runtime-fallback"], primary: "runtime-route" },
  );
  void observedEmailRouterLayer(
    [
      { layer: observedFirst, name: "first" },
      { layer: observedSecond, name: dynamicName },
    ],
    { fallbacks: ["runtime-fallback"], primary: "runtime-route" },
  );

  expectTypeOf(
    emailRouterLayer<E1, R1>([{ layer: first, name: "first" }], { primary: "runtime-route" }),
  ).toEqualTypeOf<Layer.Layer<Email | EmailRouter, E1 | EmailConfigurationError, R1>>();
  const capturedBindings = [{ layer: capturedFirst, name: "first" }] as const;
  const observedBindings = [{ layer: observedFirst, name: "first" }] as const;
  void capturedEmailRouterLayer<typeof capturedBindings>(capturedBindings, { primary: "first" });
  void observedEmailRouterLayer<typeof observedBindings>(observedBindings, { primary: "first" });
  // @ts-expect-error -- Explicit captured account tuples retain their literal route names.
  void capturedEmailRouterLayer<typeof capturedBindings>(capturedBindings, { primary: "typo" });
  // @ts-expect-error -- Explicit observed account tuples retain their literal route names.
  void observedEmailRouterLayer<typeof observedBindings>(observedBindings, { primary: "typo" });

  // @ts-expect-error -- Ordinary routing requires a nonempty binding tuple.
  void emailRouterLayer<E1, R1>([], { primary: "first" });
  // @ts-expect-error -- Captured routing requires a nonempty account tuple.
  void capturedEmailRouterLayer<typeof capturedBindings>([], { primary: "first" });
  // @ts-expect-error -- Observed routing requires a nonempty account tuple.
  void observedEmailRouterLayer<typeof observedBindings>([], { primary: "first" });
  // @ts-expect-error -- An explicit fallback list must be nonempty.
  void emailRouterLayer([{ layer: first, name: "first" }], { fallbacks: [], primary: "first" });
  // @ts-expect-error -- Captured fallback lists preserve schema nonemptiness.
  void capturedEmailRouterLayer(capturedBindings, { fallbacks: [], primary: "first" });
  // @ts-expect-error -- Observed fallback lists preserve schema nonemptiness.
  void observedEmailRouterLayer(observedBindings, { fallbacks: [], primary: "first" });

  const broadPlan: EmailRoutePlanInput = { fallbacks: [dynamicName], primary: "unregistered" };
  expectTypeOf(router.select(broadPlan)).toEqualTypeOf<
    Effect.Effect<IEmailRoute, EmailInvalidOptions>
  >();
  expectTypeOf(router.select()).toEqualTypeOf<Effect.Effect<IEmailRoute, EmailInvalidOptions>>();
};
