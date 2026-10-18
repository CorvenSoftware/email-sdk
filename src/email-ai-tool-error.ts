import { Schema } from "effect";

export class EmailAiToolError extends Schema.TaggedError<EmailAiToolError>()("EmailAiToolError", {
  reason: Schema.Literals(["defect", "not-completed"]),
}) {
  override get message(): string {
    return `Email AI tool did not complete (${this.reason}); submission may be unknown. Do not retry without host authorization.`;
  }
}
