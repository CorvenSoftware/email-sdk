import { Context } from "effect";
import type { Effect } from "effect";
import type { EmailCaptureSnapshot } from "./email-capture-retention.js";

export interface IEmailSubmissionCapture {
  readonly snapshot: Effect.Effect<EmailCaptureSnapshot>;
  readonly purgeRecords: Effect.Effect<number>;
}

export class EmailSubmissionCapture extends Context.Service<
  EmailSubmissionCapture,
  IEmailSubmissionCapture
>()("@corven/email-sdk/EmailSubmissionCapture") {}
