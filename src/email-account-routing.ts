import { Array as EffectArray, Effect, Layer } from "effect";
import { aggregatedEmailCaptureLayer } from "./email-capture-aggregate.js";
import type { EmailCaptureAggregate, EmailCaptureBinding } from "./email-capture-aggregate.js";
import type { EmailConfigurationError } from "./email-configuration-error.js";
import { aggregatedEmailObservationsLayer } from "./email-observation-aggregate.js";
import type {
  EmailObservationAggregate,
  EmailObservationBinding,
} from "./email-observation-aggregate.js";
import { emailRouterLayer, prepareEmailRouteConfiguration } from "./email-routing.js";
import type { EmailRoutePlanInput, EmailRouter } from "./email-routing.js";
import type { Email } from "./email-service.js";
import type { EmailSubmissionCapture } from "./email-submission-capture-view.js";
import type { EmailSubmissionObservations } from "./email-submission-observation-view.js";

export interface EmailCapturedRouteBinding<E, R> {
  readonly name: string;
  readonly layer: Layer.Layer<Email | EmailSubmissionCapture, E, R>;
}

export interface EmailObservedRouteBinding<E, R> {
  readonly name: string;
  readonly layer: Layer.Layer<Email | EmailSubmissionObservations, E, R>;
}

const capturedRouterLayer = <E, R>(
  bindings: readonly [EmailCapturedRouteBinding<E, R>, ...EmailCapturedRouteBinding<E, R>[]],
  defaultPlan: EmailRoutePlanInput,
): Layer.Layer<Email | EmailRouter | EmailCaptureAggregate, E | EmailConfigurationError, R> =>
  Layer.unwrap(
    Effect.gen(function* acquireCapturedEmailRoutes() {
      const accounts = Object.freeze(
        EffectArray.map<typeof bindings, EmailCapturedRouteBinding<E, R>>((binding) =>
          Object.freeze({ ...binding }),
        )(bindings),
      );

      const configuration = yield* prepareEmailRouteConfiguration(accounts, defaultPlan);

      const sources = EffectArray.map<typeof accounts, EmailCaptureBinding<E, R>>((account) => ({
        ...account,
        kind: "Submission",
      }))(accounts);

      return Layer.mergeAll(
        emailRouterLayer(accounts, configuration.plan),
        aggregatedEmailCaptureLayer(sources),
      );
    }),
  );

const observedRouterLayer = <E, R>(
  bindings: readonly [EmailObservedRouteBinding<E, R>, ...EmailObservedRouteBinding<E, R>[]],
  defaultPlan: EmailRoutePlanInput,
): Layer.Layer<Email | EmailRouter | EmailObservationAggregate, E | EmailConfigurationError, R> =>
  Layer.unwrap(
    Effect.gen(function* acquireObservedEmailRoutes() {
      const accounts = Object.freeze(
        EffectArray.map<typeof bindings, EmailObservedRouteBinding<E, R>>((binding) =>
          Object.freeze({ ...binding }),
        )(bindings),
      );

      const configuration = yield* prepareEmailRouteConfiguration(accounts, defaultPlan);

      const sources = EffectArray.map<typeof accounts, EmailObservationBinding<E, R>>(
        (account) => ({
          ...account,
          kind: "Submission",
        }),
      )(accounts);

      return Layer.mergeAll(
        emailRouterLayer(accounts, configuration.plan),
        aggregatedEmailObservationsLayer(sources),
      );
    }),
  );

type CapturedAccounts = readonly [
  EmailCapturedRouteBinding<unknown, unknown>,
  ...EmailCapturedRouteBinding<unknown, unknown>[],
];

type ObservedAccounts = readonly [
  EmailObservedRouteBinding<unknown, unknown>,
  ...EmailObservedRouteBinding<unknown, unknown>[],
];

export const capturedEmailRouterLayer = <const Accounts extends CapturedAccounts>(
  bindings: Accounts &
    readonly [
      EmailCapturedRouteBinding<
        Layer.Error<Accounts[number]["layer"]>,
        Layer.Services<Accounts[number]["layer"]>
      >,
      ...EmailCapturedRouteBinding<
        Layer.Error<Accounts[number]["layer"]>,
        Layer.Services<Accounts[number]["layer"]>
      >[],
    ],
  defaultPlan: EmailRoutePlanInput,
): Layer.Layer<
  Email | EmailRouter | EmailCaptureAggregate,
  Layer.Error<Accounts[number]["layer"]> | EmailConfigurationError,
  Layer.Services<Accounts[number]["layer"]>
> =>
  capturedRouterLayer<
    Layer.Error<Accounts[number]["layer"]>,
    Layer.Services<Accounts[number]["layer"]>
  >(bindings, defaultPlan);

export const observedEmailRouterLayer = <const Accounts extends ObservedAccounts>(
  bindings: Accounts &
    readonly [
      EmailObservedRouteBinding<
        Layer.Error<Accounts[number]["layer"]>,
        Layer.Services<Accounts[number]["layer"]>
      >,
      ...EmailObservedRouteBinding<
        Layer.Error<Accounts[number]["layer"]>,
        Layer.Services<Accounts[number]["layer"]>
      >[],
    ],
  defaultPlan: EmailRoutePlanInput,
): Layer.Layer<
  Email | EmailRouter | EmailObservationAggregate,
  Layer.Error<Accounts[number]["layer"]> | EmailConfigurationError,
  Layer.Services<Accounts[number]["layer"]>
> =>
  observedRouterLayer<
    Layer.Error<Accounts[number]["layer"]>,
    Layer.Services<Accounts[number]["layer"]>
  >(bindings, defaultPlan);
