import { Context, Schema } from "effect";
import type { Effect } from "effect";
import type { EmailAgentApprovalError } from "./email-agent-approval-error.js";
import type { EmailMessage } from "./email-message.js";
import type { EmailSendOptions } from "./email-preparation.js";
import type { EmailPreparedOperation } from "./email-prepared-operation.js";

export const EmailAgentDecisionSchema = Schema.Literals(["Approved", "Declined"]);

export type EmailAgentDecision = typeof EmailAgentDecisionSchema.Type;

export interface EmailAgentProposal {
  readonly message: EmailMessage;
  readonly options: EmailSendOptions;
  readonly previews: EmailPreparedOperation["previews"];
}

export interface IEmailAgentApproval {
  readonly review: (
    proposal: EmailAgentProposal,
  ) => Effect.Effect<EmailAgentDecision, EmailAgentApprovalError>;
}

export class EmailAgentApproval extends Context.Service<EmailAgentApproval, IEmailAgentApproval>()(
  "@corven/email-sdk/EmailAgentApproval",
) {}
