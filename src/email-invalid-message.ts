import { Schema } from "effect";
import { EmailInputIssueSchema } from "./email-input-issues.js";

export class EmailInvalidMessage extends Schema.TaggedError<EmailInvalidMessage>()(
  "EmailInvalidMessage",
  { issues: Schema.Array(EmailInputIssueSchema) },
) {
  override get message(): string {
    return `Email message is invalid (${this.issues.length} issues); inspect safe field paths and requirements.`;
  }
}
