import { Effect } from "effect";
import { validateEmailCapabilities } from "./email-capabilities.js";
import { emailInputIssues } from "./email-input-issues.js";
import { EmailInvalidOptions } from "./email-invalid-options.js";
import { EmailRejected } from "./email-rejected.js";
import { supportsEmailIdempotencyKey } from "./email-sender.js";
import type { IEmailSender } from "./email-sender.js";
import { parseEmailReplayPolicy } from "./email-submission-policy.js";
import { prepareEmailSubmission } from "./email-preparation.js";
import type { EmailSendOptionsInput, PreparedEmailSubmission } from "./email-preparation.js";
import type { EmailMessageInput } from "./email-message.js";
import { emailOperationSpan } from "./email-tracing.js";

export type EmailPreflight = Pick<
  IEmailSender,
  "provider" | "capabilities" | "idempotency" | "validate"
>;

export const preflightEmailSubmission = Effect.fnUntraced(function* preflightEmailSubmission(
  prepared: PreparedEmailSubmission,
  profile: EmailPreflight,
) {
  const { submission } = prepared;
  yield* validateEmailCapabilities(submission.message, profile.capabilities);
  yield* profile.validate(submission.message);

  if (!supportsEmailIdempotencyKey(profile.idempotency, submission.idempotencyKey)) {
    return yield* new EmailRejected({
      provider: profile.provider,
      reason: "unsupported-idempotency",
    });
  }

  if (prepared.policy !== undefined) {
    yield* parseEmailReplayPolicy(profile.idempotency, prepared.policy).pipe(
      Effect.mapError(
        (cause) =>
          new EmailInvalidOptions({
            issues: emailInputIssues(cause).map((issue) => ({
              ...issue,
              path: issue.path === "<root>" ? "policy" : `policy.${issue.path}`,
            })),
          }),
      ),
    );
  }

  return prepared;
});

export const preflightEmailMessage = Effect.fnUntraced(function* preflightEmailMessage(
  profile: EmailPreflight,
  message: EmailMessageInput,
  options?: EmailSendOptionsInput,
) {
  const prepared = yield* prepareEmailSubmission(message, options);
  yield* preflightEmailSubmission(prepared, profile);

  return prepared.submission.message;
}, emailOperationSpan("Email.preflight"));
