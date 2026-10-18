import { Schema } from "effect";

export class EmailCliError extends Schema.TaggedError<EmailCliError>()("EmailCliError", {
  reason: Schema.Literals([
    "usage",
    "input-unavailable",
    "input-limit",
    "invalid-utf8",
    "invalid-json",
    "invalid-request",
    "distribution-unavailable",
  ]),
}) {
  override get message(): string {
    return `Email CLI failed (${this.reason}); no submission was attempted.`;
  }
}
