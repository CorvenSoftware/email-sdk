import { Context, Effect, Layer, Ref, Schema } from "effect";
import { validateEmailCapabilities } from "./email-capabilities.js";
import { EmailConfigurationError } from "./email-configuration-error.js";
import { EmailSubmissionErrorSchema } from "./email-errors.js";
import type { EmailSubmissionError } from "./email-errors.js";
import { emailInputIssues } from "./email-input-issues.js";
import { ownEmailMessage } from "./email-message.js";
import { EmailRejected } from "./email-rejected.js";
import { EmailSender, EmailSenderIdempotencySchema } from "./email-sender.js";
import type { EmailSubmission } from "./email-sender.js";
import { emailLayer } from "./email-service.js";
import type {
  EmailDeliveryPolicy,
  EmailRetryObserver,
  EmailRetryRestriction,
} from "./email-service.js";
import { syntheticEmailCapabilities } from "./email-synthetic-capabilities.js";
import { emailOperationSpan } from "./email-tracing.js";

export interface IFailedEmailSubmissions {
  readonly attempts: Effect.Effect<readonly EmailSubmission[]>;
}

export class FailedEmailSubmissions extends Context.Service<
  FailedEmailSubmissions,
  IFailedEmailSubmissions
>()("@corvencore/email-sdk/FailedEmailSubmissions") {}

export const failingSenderLayer = (failure: EmailSubmissionError) =>
  Layer.effectContext(
    Effect.gen(function* acquireFailingEmailSender() {
      const encoded = yield* Schema.encodeEffect(EmailSubmissionErrorSchema)(failure).pipe(
        Effect.mapError(
          (cause) => new EmailConfigurationError({ issues: emailInputIssues(cause) }),
        ),
      );

      const ownedFailure = yield* Schema.decodeEffect(EmailSubmissionErrorSchema)({
        ...encoded,
        provider: "failing",
      }).pipe(
        Effect.mapError(
          (cause) => new EmailConfigurationError({ issues: emailInputIssues(cause) }),
        ),
      );

      Object.freeze(ownedFailure);
      const attempts = yield* Ref.make<readonly EmailSubmission[]>([]);

      const submit = Effect.fnUntraced(function* simulateFailedEmailSubmission(
        submission: EmailSubmission,
      ): Effect.fn.Return<never, EmailSubmissionError> {
        if (submission.idempotencyKey !== undefined) {
          return yield* new EmailRejected({
            provider: "failing",
            reason: "unsupported-idempotency",
          });
        }

        const owned = Object.freeze({
          ...submission,
          message: ownEmailMessage(submission.message),
        });

        yield* Ref.update(attempts, (current) => [...current, owned]);

        return yield* ownedFailure;
      }, emailOperationSpan("FailingEmailSender.submit"));

      return Context.make(
        EmailSender,
        EmailSender.of({
          capabilities: syntheticEmailCapabilities,
          idempotency: EmailSenderIdempotencySchema.cases.None.make({}),
          provider: "failing",
          submit,
          validate: (message) => validateEmailCapabilities(message, syntheticEmailCapabilities),
        }),
      ).pipe(
        Context.add(
          FailedEmailSubmissions,
          FailedEmailSubmissions.of({
            attempts: Ref.get(attempts).pipe(
              Effect.map((current) => Object.freeze([...current])),
              emailOperationSpan("FailedEmailSubmissions.attempts"),
            ),
          }),
        ),
      );
    }),
  );

export const failingEmailLayer = (
  failure: EmailSubmissionError,
  policy?: EmailDeliveryPolicy,
  observer?: EmailRetryObserver,
  restriction?: EmailRetryRestriction,
) =>
  emailLayer(policy, observer, restriction).pipe(Layer.provideMerge(failingSenderLayer(failure)));
