import { Schema } from "effect";

export class EmailAgentApprovalError extends Schema.TaggedError<EmailAgentApprovalError>()(
  "EmailAgentApprovalError",
  { reason: Schema.Literals(["declined", "unavailable"]) },
) {
  override get message(): string {
    return `Email agent approval failed (${this.reason}); no submission was authorized by this operation.`;
  }
}
