import { Context, Effect, Layer, Schema } from "effect";
import type { Result, Scope } from "effect";
import { acquireEmailExtension } from "./email-extension.js";
import type { EmailExtension } from "./email-extension.js";
import type { EmailPersonalizationMode } from "./email-composition.js";
import { EmailConfigurationError } from "./email-configuration-error.js";
import { EmailSenderCapabilitiesSchema, ownEmailSenderCapabilities } from "./email-capabilities.js";
import type { EmailSenderCapabilities } from "./email-capabilities.js";
import { emailOperationSpan } from "./email-tracing.js";
import type { EmailRejected } from "./email-rejected.js";
import { preflightEmailSubmission } from "./email-preflight.js";
import type { EmailPersonalizedInput } from "./email-personalization.js";
import { parseEmailReplayPolicy, submitEmailWithPolicy } from "./email-submission-policy.js";
import type { EmailDeliveryPolicy } from "./email-delivery-policy.js";
import type { EmailRetryObserver, EmailRetryRestriction } from "./email-retry-decision.js";
import type { EmailSendError, EmailSubmissionError } from "./email-errors.js";
import { emailInputIssues } from "./email-input-issues.js";
import type { EmailInvalidOptions } from "./email-invalid-options.js";
import type { EmailInvalidMessage } from "./email-invalid-message.js";
import type { EmailMessage, EmailMessageInput, EmailReceipt } from "./email-message.js";
import {
  EmailSender,
  EmailSenderIdempotencySchema,
  ownEmailSenderIdempotency,
} from "./email-sender.js";
import { emailPreparedOperations, preparedEmailOperation } from "./email-prepared-operation.js";
import type { EmailPreparedOperation } from "./email-prepared-operation.js";
import { preparedEmailSendOptions } from "./email-preparation.js";
import type {
  EmailBatchOptionsInput,
  EmailPersonalizedOptionsInput,
  EmailSendOptionsInput,
  EmailSendRequest,
  PreparedEmailSubmission,
} from "./email-preparation.js";

export { EmailDeliveryPolicySchema } from "./email-delivery-policy.js";

export type { EmailDeliveryPolicy } from "./email-delivery-policy.js";

export type { EmailRetryObserver, EmailRetryRestriction } from "./email-retry-decision.js";

export {
  EmailBatchOptionsSchema,
  EmailExecutionMetadataSchema,
  EmailPersonalizedOptionsSchema,
  EmailSendOptionsSchema,
  EmailSendRequestSchema,
} from "./email-preparation.js";

export type {
  EmailBatchOptionsInput,
  EmailExecutionMetadata,
  EmailExecutionMetadataInput,
  EmailExecutionMetadataValue,
  EmailExecutionMetadataInputValue,
  EmailPersonalizedOptionsInput,
  EmailSendOptions,
  EmailSendOptionsInput,
  EmailSendRequest,
} from "./email-preparation.js";

export interface IEmail {
  readonly personalization: EmailPersonalizationMode;
  readonly capabilities: EmailSenderCapabilities;
  readonly prepare: (
    message: EmailMessageInput,
    options?: EmailSendOptionsInput,
  ) => Effect.Effect<
    EmailPreparedOperation,
    EmailInvalidMessage | EmailInvalidOptions | EmailRejected
  >;
  readonly validate: (
    message: EmailMessageInput,
    options?: EmailSendOptionsInput,
  ) => Effect.Effect<EmailMessage, EmailInvalidMessage | EmailInvalidOptions | EmailRejected>;
  readonly send: (
    message: EmailMessageInput,
    options?: EmailSendOptionsInput,
  ) => Effect.Effect<EmailReceipt, EmailSendError>;
  readonly sendPersonalized: (
    input: EmailPersonalizedInput,
    options?: EmailPersonalizedOptionsInput,
  ) => Effect.Effect<
    readonly Result.Result<EmailReceipt, EmailSendError>[],
    EmailInvalidMessage | EmailInvalidOptions
  >;
  readonly sendAll: (
    requests: readonly EmailSendRequest[],
    options?: EmailBatchOptionsInput,
  ) => Effect.Effect<readonly Result.Result<EmailReceipt, EmailSendError>[], EmailInvalidOptions>;
}

export class Email extends Context.Service<Email, IEmail>()("@corven/email-sdk/Email") {}

const parseIdempotency = Schema.decodeUnknownEffect(Schema.toType(EmailSenderIdempotencySchema), {
  errors: "all",
  onExcessProperty: "error",
});

export const emailLayer = <EO = never, RO = never, ER = never, RR = never>(
  policy?: EmailDeliveryPolicy,
  observer?: EmailExtension<EmailRetryObserver, EO, RO>,
  restriction?: EmailExtension<EmailRetryRestriction, ER, RR>,
): Layer.Layer<
  Email,
  EmailConfigurationError | EO | ER,
  EmailSender | Exclude<RO | RR, Scope.Scope>
> =>
  Layer.effect(
    Email,
    Effect.gen(function* makeEmail() {
      const sender = yield* EmailSender;

      const observeRetry =
        observer === undefined ? undefined : yield* acquireEmailExtension(observer);

      const restrictRetry =
        restriction === undefined ? undefined : yield* acquireEmailExtension(restriction);

      const parsedCapabilities = yield* Schema.decodeEffect(EmailSenderCapabilitiesSchema, {
        errors: "all",
        onExcessProperty: "error",
      })(sender.capabilities).pipe(
        Effect.mapError(
          (cause) => new EmailConfigurationError({ issues: emailInputIssues(cause) }),
        ),
      );

      const capabilities = ownEmailSenderCapabilities(parsedCapabilities);

      const parsedIdempotency = yield* parseIdempotency(sender.idempotency).pipe(
        Effect.mapError(
          (cause) => new EmailConfigurationError({ issues: emailInputIssues(cause) }),
        ),
      );

      const idempotency = ownEmailSenderIdempotency(parsedIdempotency);

      const resolvedPolicy = yield* parseEmailReplayPolicy(idempotency, policy).pipe(
        Effect.mapError(
          (cause) => new EmailConfigurationError({ issues: emailInputIssues(cause) }),
        ),
      );

      const profile = {
        capabilities,
        idempotency,
        provider: sender.provider,
        validate: (message: EmailMessage) => sender.validate(message),
      };

      const preflight = (prepared: PreparedEmailSubmission) =>
        preflightEmailSubmission(prepared, profile);

      const submit = Effect.fnUntraced(function* submitEmail(
        prepared: PreparedEmailSubmission,
      ): Effect.fn.Return<EmailReceipt, EmailSubmissionError> {
        const { submission } = prepared;

        return yield* submitEmailWithPolicy(
          sender.submit(submission),
          { idempotency, provider: sender.provider },
          submission.idempotencyKey,
          prepared.policy ?? resolvedPolicy,
          observeRetry,
          restrictRetry,
        );
      }, emailOperationSpan("Email.submit"));

      const prepare = Effect.fnUntraced(function* prepareSenderEmail(
        prepared: PreparedEmailSubmission,
      ) {
        yield* preflight(prepared);

        return preparedEmailOperation(
          [
            {
              message: prepared.submission.message,
              options: preparedEmailSendOptions(prepared),
              routes: [],
            },
          ],
          preflight(prepared).pipe(Effect.asVoid),
          submit(prepared),
        );
      });

      return Email.of({ capabilities, ...emailPreparedOperations(prepare) });
    }),
  );
