import {
  Array as EffectArray,
  Context,
  Duration,
  Effect,
  Layer,
  Match,
  Result,
  Schema,
  Struct,
} from "effect";
import { requireIndividualEmailPreparation } from "./email-composition.js";
import type { EmailSenderCapabilities } from "./email-capabilities.js";
import {
  EmailSenderCapabilitiesSchema,
  ownEmailSenderCapabilities,
  intersectEmailSenderCapabilities,
} from "./email-capabilities.js";
import { EmailConfigurationError } from "./email-configuration-error.js";
import { EmailDeliveryUnknown } from "./email-delivery-unknown.js";
import type { EmailSendError } from "./email-errors.js";
import { emailInputIssues } from "./email-input-issues.js";
import { EmailInvalidOptions } from "./email-invalid-options.js";
import type { EmailInvalidMessage } from "./email-invalid-message.js";
import { EmailReceiptSchema } from "./email-message.js";
import type { EmailMessageInput } from "./email-message.js";
import type { EmailPersonalizedInput } from "./email-personalization.js";
import { emailPreparedOperations, preparedEmailOperation } from "./email-prepared-operation.js";
import type { EmailPreparedOperation, EmailPreparedPreview } from "./email-prepared-operation.js";
import { preparedEmailSendOptions } from "./email-preparation.js";
import type {
  EmailBatchOptionsInput,
  EmailPersonalizedOptionsInput,
  EmailSendOptionsInput,
  EmailSendRequest,
  PreparedEmailSubmission,
} from "./email-preparation.js";
import { Email } from "./email-service.js";
import { protectEmailUnsettledCause } from "./email-unsettled-cause.js";
import { emailOperationSpan } from "./email-tracing.js";
import type { IEmail } from "./email-service.js";
import type { EmailRejected } from "./email-rejected.js";

export const EmailRouteNameSchema = Schema.String.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[a-z][a-z0-9_-]*$/u, { expected: "a lowercase opaque email route name" }),
).pipe(Schema.brand("EmailRouteName"));

export type EmailRouteName = typeof EmailRouteNameSchema.Type;

export const EmailRoutePlanSchema = Schema.Struct({
  deadline: Schema.optionalKey(
    Schema.Duration.check(
      Schema.makeFilter(
        (duration) =>
          Number.isFinite(Duration.toMillis(duration)) && Duration.toMillis(duration) > 0,
        { expected: "a positive finite routing deadline" },
      ),
    ),
  ),
  fallbacks: Schema.optionalKey(
    Schema.NonEmptyArray(EmailRouteNameSchema).check(Schema.isMaxLength(15)),
  ),
  primary: EmailRouteNameSchema,
}).check(
  Schema.makeFilter(
    (plan) =>
      new Set([plan.primary, ...(plan.fallbacks ?? [])]).size === 1 + (plan.fallbacks?.length ?? 0),
    { expected: "distinct primary and fallback routes" },
  ),
);

export type EmailRoutePlanInput = typeof EmailRoutePlanSchema.Encoded;

export const EmailRoutedReceiptSchema = Schema.Union([
  EmailReceiptSchema.cases.Accepted.mapFields((fields) => ({
    ...fields,
    route: EmailRouteNameSchema,
  })),
  EmailReceiptSchema.cases.AcceptedWithIds.mapFields((fields) => ({
    ...fields,
    route: EmailRouteNameSchema,
  })),
  EmailReceiptSchema.cases.PartiallyAccepted.mapFields((fields) => ({
    ...fields,
    route: EmailRouteNameSchema,
  })),
  EmailReceiptSchema.cases.PartiallyRejected.mapFields((fields) => ({
    ...fields,
    route: EmailRouteNameSchema,
  })),
  EmailReceiptSchema.cases.PartiallyAcceptedCounts.mapFields((fields) => ({
    ...fields,
    route: EmailRouteNameSchema,
  })),
  EmailReceiptSchema.cases.RecipientsRejected.mapFields((fields) => ({
    ...fields,
    route: EmailRouteNameSchema,
  })),
  EmailReceiptSchema.cases.RecipientOutcomes.mapFields((fields) => ({
    ...fields,
    route: EmailRouteNameSchema,
  })),
  EmailReceiptSchema.cases.Recorded.mapFields((fields) => ({
    ...fields,
    route: EmailRouteNameSchema,
  })),
  EmailReceiptSchema.cases.Simulated.mapFields((fields) => ({
    ...fields,
    route: EmailRouteNameSchema,
  })),
  EmailReceiptSchema.cases.Suppressed.mapFields((fields) => ({
    ...fields,
    route: EmailRouteNameSchema,
  })),
]);

export type EmailRoutedReceipt = typeof EmailRoutedReceiptSchema.Type;

export interface IEmailRoute extends IEmail {
  readonly prepare: (
    message: EmailMessageInput,
    options?: EmailSendOptionsInput,
  ) => Effect.Effect<
    EmailPreparedOperation<EmailRoutedReceipt>,
    EmailInvalidMessage | EmailInvalidOptions | EmailRejected
  >;
  readonly send: (
    message: EmailMessageInput,
    options?: EmailSendOptionsInput,
  ) => Effect.Effect<EmailRoutedReceipt, EmailSendError>;
  readonly sendAll: (
    requests: readonly EmailSendRequest[],
    options?: EmailBatchOptionsInput,
  ) => Effect.Effect<
    readonly Result.Result<EmailRoutedReceipt, EmailSendError>[],
    EmailInvalidOptions
  >;
  readonly sendPersonalized: (
    input: EmailPersonalizedInput,
    options?: EmailPersonalizedOptionsInput,
  ) => Effect.Effect<
    readonly Result.Result<EmailRoutedReceipt, EmailSendError>[],
    EmailInvalidMessage | EmailInvalidOptions
  >;
}

export interface EmailRouteBinding<E, R> {
  readonly name: string;
  readonly layer: Layer.Layer<Email, E, R>;
}

export interface IEmailRouter {
  readonly routes: readonly {
    readonly name: EmailRouteName;
    readonly capabilities: EmailSenderCapabilities;
  }[];
  readonly select: (plan?: EmailRoutePlanInput) => Effect.Effect<IEmailRoute, EmailInvalidOptions>;
}

export class EmailRouter extends Context.Service<EmailRouter, IEmailRouter>()(
  "@corven/email-sdk/EmailRouter",
) {}

const RouteRegistrationsSchema = Schema.NonEmptyArray(
  Schema.Struct({ name: EmailRouteNameSchema }),
).check(
  Schema.isMaxLength(16),
  Schema.makeFilter(
    (registrations) =>
      new Set(registrations.map((registration) => registration.name)).size === registrations.length,
    { expected: "distinct email route names" },
  ),
);

const parseRouteRegistrations = Schema.decodeEffect(RouteRegistrationsSchema, {
  errors: "all",
  onExcessProperty: "error",
});

const ownEmailRoutePlan = (plan: typeof EmailRoutePlanSchema.Type) =>
  Object.freeze({
    deadline: Duration.millis(Duration.toMillis(plan.deadline ?? Duration.seconds(30))),
    fallbacks: Object.freeze([...(plan.fallbacks ?? [])]),
    primary: plan.primary,
  });

const canFallbackEmailSubmission = (failure: EmailSendError): boolean =>
  Match.value(failure).pipe(
    Match.tag(
      "EmailRejected",
      (rejected) =>
        rejected.reason !== "idempotency-conflict" && rejected.reason !== "unsupported-idempotency",
    ),
    Match.orElse(() => false),
  );

interface PreparedEmailRouteConfiguration<E, R> {
  readonly bindings: readonly [EmailRouteBinding<E, R>, ...EmailRouteBinding<E, R>[]];
  readonly decodePlan: (
    input: EmailRoutePlanInput,
  ) => Effect.Effect<typeof EmailRoutePlanSchema.Type, Schema.SchemaError>;
  readonly defaultRoute: ReturnType<typeof ownEmailRoutePlan>;
  readonly plan: EmailRoutePlanInput;
}

export const prepareEmailRouteConfiguration = <E, R>(
  bindings: readonly [EmailRouteBinding<E, R>, ...EmailRouteBinding<E, R>[]],
  defaultPlan: EmailRoutePlanInput,
): Effect.Effect<PreparedEmailRouteConfiguration<E, R>, EmailConfigurationError> =>
  Effect.gen(function* ownEmailRouteConfiguration() {
    const ownedBindings = Object.freeze(
      EffectArray.map<typeof bindings, EmailRouteBinding<E, R>>((binding) =>
        Object.freeze({ ...binding }),
      )(bindings),
    );

    const metadata = EffectArray.map<typeof ownedBindings, Omit<EmailRouteBinding<E, R>, "layer">>(
      (binding) => Struct.omit(binding, ["layer"]),
    )(ownedBindings);

    const registrations = yield* parseRouteRegistrations(metadata);
    const names = new Set(registrations.map((registration) => registration.name));

    const registeredPlan = EmailRoutePlanSchema.check(
      Schema.makeFilter(
        (plan) => [plan.primary, ...(plan.fallbacks ?? [])].every((name) => names.has(name)),
        { expected: "registered email routes" },
      ),
    );

    const decodePlan = Schema.decodeUnknownEffect(registeredPlan, {
      errors: "all",
      onExcessProperty: "error",
    });

    const defaultRoute = yield* decodePlan(defaultPlan).pipe(Effect.map(ownEmailRoutePlan));

    const [first, ...remaining] = defaultRoute.fallbacks;

    const plan: EmailRoutePlanInput =
      first === undefined
        ? Object.freeze(Struct.omit(defaultRoute, ["fallbacks"]))
        : Object.freeze({
            ...defaultRoute,
            fallbacks: Object.freeze([first, ...remaining] as const),
          });

    return { bindings: ownedBindings, decodePlan, defaultRoute, plan };
  }).pipe(
    Effect.mapError((cause) => new EmailConfigurationError({ issues: emailInputIssues(cause) })),
  );

export const emailRouterLayer = <E, R>(
  bindings: readonly [EmailRouteBinding<E, R>, ...EmailRouteBinding<E, R>[]],
  defaultPlan: EmailRoutePlanInput,
): Layer.Layer<EmailRouter | Email, E | EmailConfigurationError, R> =>
  Layer.fromBuildMemo((memoMap, scope) =>
    Effect.gen(function* makeEmailRouter() {
      const {
        bindings: ownedBindings,
        decodePlan,
        defaultRoute,
      } = yield* prepareEmailRouteConfiguration(bindings, defaultPlan);

      const services = yield* Effect.forEach(
        ownedBindings,
        Effect.fnUntraced(function* acquireEmailRoute(binding: EmailRouteBinding<E, R>) {
          const name = yield* Schema.decodeEffect(EmailRouteNameSchema)(binding.name).pipe(
            Effect.mapError(
              (cause) => new EmailConfigurationError({ issues: emailInputIssues(cause) }),
            ),
          );

          const context = yield* Layer.buildWithMemoMap(binding.layer, memoMap, scope);
          const service = Context.get(context, Email);

          const capabilities = yield* Schema.decodeEffect(EmailSenderCapabilitiesSchema, {
            errors: "all",
            onExcessProperty: "error",
          })(service.capabilities).pipe(
            Effect.mapError(
              (cause) => new EmailConfigurationError({ issues: emailInputIssues(cause) }),
            ),
          );

          const email = Object.freeze({
            ...service,
            capabilities: ownEmailSenderCapabilities(capabilities),
          });

          return { email, name };
        }),
        { concurrency: 1 },
      );

      const registry = new Map<EmailRouteName, IEmail>();

      for (const service of services) {
        registry.set(service.name, service.email);
      }

      const requireRoute = (name: EmailRouteName) => {
        const email = registry.get(name);

        return email === undefined
          ? Effect.fail(
              new EmailInvalidOptions({
                issues: [{ path: "primary", problem: "Unregistered email route" }],
              }),
            )
          : Effect.succeed({ email, name });
      };

      const select = Effect.fnUntraced(function* selectEmailRoute(
        input?: EmailRoutePlanInput,
      ): Effect.fn.Return<IEmailRoute, EmailInvalidOptions> {
        const plan =
          input === undefined
            ? defaultRoute
            : yield* decodePlan(input).pipe(
                Effect.map(ownEmailRoutePlan),
                Effect.mapError(
                  (cause) => new EmailInvalidOptions({ issues: emailInputIssues(cause) }),
                ),
              );

        const primary = yield* requireRoute(plan.primary);
        const fallbacks = yield* Effect.forEach(plan.fallbacks, requireRoute, { concurrency: 1 });
        const candidates = [primary, ...fallbacks] as const;

        yield* Effect.forEach(
          candidates,
          (candidate) => requireIndividualEmailPreparation(candidate.email.personalization),
          { concurrency: 1, discard: true },
        ).pipe(Effect.mapError((failure) => new EmailInvalidOptions({ issues: failure.issues })));

        const capabilities = intersectEmailSenderCapabilities([
          primary.email.capabilities,
          ...fallbacks.map((fallback) => fallback.email.capabilities),
        ]);

        const prepare = Effect.fnUntraced(function* prepareRoutedOperation(
          prepared: PreparedEmailSubmission,
        ) {
          const options = preparedEmailSendOptions(prepared);

          const preparedCandidates = yield* Effect.forEach(
            candidates,
            Effect.fnUntraced(function* prepareRouteCandidate(candidate: typeof primary) {
              const operation = yield* candidate.email.prepare(
                prepared.submission.message,
                options,
              );

              return { name: candidate.name, operation };
            }),
            { concurrency: 1 },
          );

          const [first, ...remaining] = preparedCandidates;

          const attemptRoute = Effect.fnUntraced(function* attemptPreparedRoute(
            candidate: typeof first,
            rest: readonly (typeof first)[],
          ): Effect.fn.Return<EmailRoutedReceipt, EmailSendError> {
            const result = yield* candidate.operation.validate.pipe(
              Effect.andThen(candidate.operation.send),
              protectEmailUnsettledCause,
              Effect.result,
            );

            if (Result.isSuccess(result)) {
              return Object.freeze({ ...result.success, route: candidate.name });
            }

            const [next, ...tail] = rest;

            return canFallbackEmailSubmission(result.failure) && next !== undefined
              ? yield* attemptRoute(next, tail)
              : yield* result.failure;
          });

          const submit = attemptRoute(first, remaining).pipe(
            Effect.timeoutOrElse({
              duration: plan.deadline,
              orElse: () =>
                Effect.fail(
                  new EmailDeliveryUnknown({ provider: "email-router", reason: "timeout" }),
                ),
            }),
            emailOperationSpan("EmailRouter.submit"),
          );

          const previews = EffectArray.flatMap<
            typeof preparedCandidates,
            EmailPreparedOperation["previews"]
          >((candidate) =>
            EffectArray.map<EmailPreparedOperation["previews"], EmailPreparedPreview>(
              (preview) => ({ ...preview, routes: [candidate.name, ...preview.routes] }),
            )(candidate.operation.previews),
          )(preparedCandidates);

          const validate = Effect.forEach(
            preparedCandidates,
            (candidate) => candidate.operation.validate,
            {
              concurrency: 1,
              discard: true,
            },
          );

          return preparedEmailOperation(previews, validate, submit);
        });

        return Object.freeze({ capabilities, ...emailPreparedOperations(prepare) });
      }, emailOperationSpan("EmailRouter.select"));

      const defaultEmail = yield* select().pipe(
        Effect.mapError((failure) => new EmailConfigurationError({ issues: failure.issues })),
      );

      const routes = Object.freeze(
        services.map((service) =>
          Object.freeze({ capabilities: service.email.capabilities, name: service.name }),
        ),
      );

      const router = EmailRouter.of({ routes, select });

      return Context.make(EmailRouter, router).pipe(Context.add(Email, defaultEmail));
    }),
  );
