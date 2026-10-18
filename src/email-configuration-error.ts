import { Schema } from "effect";
import { EmailInputIssueSchema } from "./email-input-issues.js";

export class EmailConfigurationError extends Schema.TaggedError<EmailConfigurationError>()(
  "EmailConfigurationError",
  { issues: Schema.Array(EmailInputIssueSchema) },
) {
  override get message(): string {
    return `Email configuration is invalid (${this.issues.length} issues); correct the supplied Layer options.`;
  }
}
