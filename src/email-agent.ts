import { Context, Effect, Layer, Match, Schema } from "effect";
import { EmailMailboxSchema, ownEmailMailbox } from "./email-address.js";
import { EmailAgentApproval } from "./email-agent-approval.js";
import { EmailAgentApprovalError } from "./email-agent-approval-error.js";
import { EmailConfigurationError } from "./email-configuration-error.js";
import type { EmailSendError } from "./email-errors.js";
import { emailInputIssues } from "./email-input-issues.js";
import { EmailInvalidMessage } from "./email-invalid-message.js";
import { EmailMessageSchema } from "./email-message.js";
import type { EmailReceipt } from "./email-message.js";
import type { EmailSendOptionsInput } from "./email-preparation.js";
import { ownEmailPreparedPreviews } from "./email-prepared-operation.js";
import { Email } from "./email-service.js";
import { emailOperationSpan } from "./email-tracing.js";

export const EmailAgentInputSchema = Schema.Struct({
  body: EmailMessageSchema.fields.body,
  subject: EmailMessageSchema.fields.subject,
  to: EmailMessageSchema.fields.to,
});

export type EmailAgentInput = typeof EmailAgentInputSchema.Encoded;

export const EmailAgentOptionsSchema = Schema.Struct({ from: EmailMailboxSchema });

export type EmailAgentOptions = typeof EmailAgentOptionsSchema.Encoded;

export { EmailAgentApproval, EmailAgentDecisionSchema } from "./email-agent-approval.js";

export type {
  EmailAgentDecision,
  EmailAgentProposal,
  IEmailAgentApproval,
} from "./email-agent-approval.js";

export { EmailAgentApprovalError } from "./email-agent-approval-error.js";

export interface IEmailAgent {
  readonly submit: (
    input: EmailAgentInput,
    options?: EmailSendOptionsInput,
  ) => Effect.Effect<EmailReceipt, EmailSendError | EmailAgentApprovalError>;
}

export class EmailAgent extends Context.Service<EmailAgent, IEmailAgent>()(
  "@corvencore/email-sdk/EmailAgent",
) {}

const decodeAgentInput = Schema.decodeUnknownEffect(EmailAgentInputSchema, {
  errors: "all",
  onExcessProperty: "error",
});

export const emailAgentLayer = (
  options: EmailAgentOptions,
): Layer.Layer<EmailAgent, EmailConfigurationError, Email | EmailAgentApproval> =>
  Layer.effect(
    EmailAgent,
    Effect.gen(function* acquireEmailAgent() {
      const configuration = yield* Schema.decodeEffect(EmailAgentOptionsSchema, {
        errors: "all",
        onExcessProperty: "error",
      })(options).pipe(
        Effect.mapError(
          (cause) => new EmailConfigurationError({ issues: emailInputIssues(cause) }),
        ),
      );

      const from = ownEmailMailbox(configuration.from);
      const email = yield* Email;
      const approval = yield* EmailAgentApproval;

      const submit = Effect.fnUntraced(function* submitAgentEmail(
        input: EmailAgentInput,
        operationOptions?: EmailSendOptionsInput,
      ) {
        const parsed = yield* decodeAgentInput(input).pipe(
          Effect.mapError((cause) => new EmailInvalidMessage({ issues: emailInputIssues(cause) })),
        );

        const operation = yield* email.prepare({ ...parsed, from }, operationOptions);
        const previews = ownEmailPreparedPreviews(operation.previews);
        const [preview] = previews;

        const proposal = Object.freeze({
          message: preview.message,
          options: preview.options,
          previews,
        });

        const decision = yield* approval.review(proposal);

        return yield* Match.value(decision).pipe(
          Match.when("Approved", () => operation.validate.pipe(Effect.andThen(operation.send))),
          Match.when("Declined", () => new EmailAgentApprovalError({ reason: "declined" })),
          Match.exhaustive,
        );
      }, emailOperationSpan("EmailAgent.submit"));

      return EmailAgent.of({ submit });
    }),
  );
