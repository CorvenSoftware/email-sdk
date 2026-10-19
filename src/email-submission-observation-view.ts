import type { Effect } from "effect";
import { Context, Schema, Struct } from "effect";
import { EmailReceiptSchema } from "./email-message.js";

export const EmailSubmissionObservationSchema = Schema.TaggedUnion({
  Receipt: {
    provider: Schema.String,
    receiptKind: Schema.Literals(Struct.keys(EmailReceiptSchema.cases)),
  },
  Rejected: { provider: Schema.String },
  Unknown: { provider: Schema.String },
});

export type EmailSubmissionObservation = typeof EmailSubmissionObservationSchema.Type;

export type EmailSubmissionObserver = (
  observation: EmailSubmissionObservation,
) => Effect.Effect<void>;

export const EmailSubmissionObservationSnapshotSchema = Schema.Struct({
  observations: Schema.Array(EmailSubmissionObservationSchema),
  truncated: Schema.Boolean,
});

export type EmailSubmissionObservationSnapshot =
  typeof EmailSubmissionObservationSnapshotSchema.Type;

export interface IEmailSubmissionObservations {
  readonly snapshot: Effect.Effect<EmailSubmissionObservationSnapshot>;
}

export class EmailSubmissionObservations extends Context.Service<
  EmailSubmissionObservations,
  IEmailSubmissionObservations
>()("@corvencore/email-sdk/EmailSubmissionObservations") {}
