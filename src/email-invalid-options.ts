import { Schema } from "effect";
import { EmailInputIssueSchema } from "./email-input-issues.js";

export class EmailInvalidOptions extends Schema.TaggedError<EmailInvalidOptions>()(
  "EmailInvalidOptions",
  { issues: Schema.Array(EmailInputIssueSchema) },
) {
  override get message(): string {
    return `Email options are invalid (${this.issues.length} issues); correct them before submitting again.`;
  }
}
