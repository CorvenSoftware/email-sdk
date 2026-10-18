import { Schema } from "effect";

export class EmailCaptureAggregateError extends Schema.TaggedError<EmailCaptureAggregateError>()(
  "EmailCaptureAggregateError",
  { reason: Schema.Literal("invalid-source") },
) {}
