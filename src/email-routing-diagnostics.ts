import { Duration, Effect, Match, Schema, Struct } from "effect";
import { emailInputIssues } from "./email-input-issues.js";
import { EmailInvalidMessage } from "./email-invalid-message.js";
import { EmailInvalidOptions } from "./email-invalid-options.js";
import { prepareEmailSendRequest, preparedEmailSendOptions } from "./email-preparation.js";
import type { EmailSendRequest } from "./email-preparation.js";
import { EmailRejected } from "./email-rejected.js";
import { EmailRouter, EmailRouteNameSchema, EmailRoutePlanSchema } from "./email-routing.js";
import type { EmailRouteName, EmailRoutePlanInput } from "./email-routing.js";
import { emailOperationSpan } from "./email-tracing.js";
import { protectEmailUnsettledCause } from "./email-unsettled-cause.js";

export const EmailRouteCompatibilitySchema = Schema.TaggedUnion({
  Compatible: { name: EmailRouteNameSchema },
  Incompatible: {
    failure: Schema.Union([EmailInvalidMessage, EmailInvalidOptions, EmailRejected]),
    name: EmailRouteNameSchema,
  },
});

export type EmailRouteCompatibility = typeof EmailRouteCompatibilitySchema.Type;

export const EmailRoutePlanExplanationSchema = Schema.Struct({
  candidates: Schema.NonEmptyArray(EmailRouteCompatibilitySchema),
  compatible: Schema.Boolean,
}).check(
  Schema.makeFilter(
    (explanation) =>
      explanation.compatible ===
      explanation.candidates.every(EmailRouteCompatibilitySchema.guards.Compatible),
    { expected: "compatibility consistent with every candidate" },
  ),
);

export type EmailRoutePlanExplanation = typeof EmailRoutePlanExplanationSchema.Type;

const freezeEmailRouteValidationFailure = <
  Failure extends EmailInvalidMessage | EmailInvalidOptions,
>(
  failure: Failure,
): Failure => {
  for (const issue of failure.issues) {
    Object.freeze(issue);
  }

  Object.freeze(failure.issues);

  return Object.freeze(failure);
};

const ownEmailRouteCompatibilityFailure = (
  failure: EmailInvalidMessage | EmailInvalidOptions | EmailRejected,
): EmailInvalidMessage | EmailInvalidOptions | EmailRejected =>
  Match.value(failure).pipe(
    Match.tag("EmailInvalidMessage", ({ issues }) =>
      freezeEmailRouteValidationFailure(
        new EmailInvalidMessage({
          issues: issues.map(({ path, problem }) => ({ path, problem })),
        }),
      ),
    ),
    Match.tag("EmailInvalidOptions", ({ issues }) =>
      freezeEmailRouteValidationFailure(
        new EmailInvalidOptions({
          issues: issues.map(({ path, problem }) => ({ path, problem })),
        }),
      ),
    ),
    Match.tag("EmailRejected", (rejected) =>
      Object.freeze(
        new EmailRejected(
          Struct.pick(rejected, [
            "provider",
            "providerCode",
            "reason",
            "retryAfterMillis",
            "status",
          ]),
        ),
      ),
    ),
    Match.exhaustive,
  );

export const explainEmailRoutePlan = Effect.fnUntraced(function* explainEmailRoutePlan(
  plan: EmailRoutePlanInput,
  request: EmailSendRequest,
): Effect.fn.Return<
  EmailRoutePlanExplanation,
  EmailInvalidMessage | EmailInvalidOptions,
  EmailRouter
> {
  const parsedPlan = yield* Schema.decodeEffect(EmailRoutePlanSchema, {
    errors: "all",
    onExcessProperty: "error",
  })(plan).pipe(
    Effect.mapError((cause) => new EmailInvalidOptions({ issues: emailInputIssues(cause) })),
  );

  const names: readonly [EmailRouteName, ...EmailRouteName[]] = Object.freeze([
    parsedPlan.primary,
    ...(parsedPlan.fallbacks ?? []),
  ]);

  const deadline =
    parsedPlan.deadline === undefined
      ? undefined
      : Duration.millis(Duration.toMillis(parsedPlan.deadline));

  const prepared = yield* prepareEmailSendRequest(request);
  const options = preparedEmailSendOptions(prepared);
  const router = yield* EmailRouter;

  const candidates = yield* Effect.forEach(
    names,
    (name) => {
      let candidatePlan: EmailRoutePlanInput = { primary: name };

      if (deadline !== undefined) {
        candidatePlan = { ...candidatePlan, deadline };
      }

      return router.select(candidatePlan).pipe(
        Effect.flatMap((route) => route.prepare(prepared.submission.message, options)),
        protectEmailUnsettledCause,
        Effect.match({
          onFailure: (failure) =>
            Object.freeze(
              EmailRouteCompatibilitySchema.cases.Incompatible.make({
                failure: ownEmailRouteCompatibilityFailure(failure),
                name,
              }),
            ),
          onSuccess: () =>
            Object.freeze(EmailRouteCompatibilitySchema.cases.Compatible.make({ name })),
        }),
      );
    },
    { concurrency: 1 },
  );

  return Object.freeze({
    candidates: Object.freeze(candidates),
    compatible: candidates.every(EmailRouteCompatibilitySchema.guards.Compatible),
  });
}, emailOperationSpan("EmailRouter.explain"));
