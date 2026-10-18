import { Schema } from "effect";
import { EmailDeliveryUnknown } from "./email-delivery-unknown.js";
import type { EmailInvalidMessage } from "./email-invalid-message.js";
import type { EmailInvalidOptions } from "./email-invalid-options.js";
import { EmailRejected } from "./email-rejected.js";

export const EmailSubmissionErrorSchema = Schema.Union([EmailRejected, EmailDeliveryUnknown]);

export type EmailSubmissionError = typeof EmailSubmissionErrorSchema.Type;

export type EmailSendError = EmailInvalidMessage | EmailInvalidOptions | EmailSubmissionError;
