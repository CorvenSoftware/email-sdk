import { Schema } from "effect";

export class EmailObservationAggregateError extends Schema.TaggedError<EmailObservationAggregateError>()(
  "EmailObservationAggregateError",
  { reason: Schema.Literal("invalid-source") },
) {}
