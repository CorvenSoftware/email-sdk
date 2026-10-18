import { Schema } from "effect";

import { EmailWebhookBodySchema } from "./email-webhook-body.js";

export const ResendWebhookIdSchema = Schema.String.check(
  Schema.isMaxLength(256),
  Schema.isPattern(/^[A-Za-z0-9_-]+$/u),
).pipe(Schema.brand("ResendWebhookId"));

export const ResendWebhookTimestampSchema = Schema.String.check(
  Schema.isPattern(/^(?:0|[1-9][0-9]{0,9})$/u),
).pipe(Schema.brand("ResendWebhookTimestampSeconds"));

export const VerifiedResendWebhookSchema = Schema.Struct({
  body: EmailWebhookBodySchema,
  id: ResendWebhookIdSchema,
  timestamp: ResendWebhookTimestampSchema,
}).pipe(Schema.brand("VerifiedResendWebhook"));

export type VerifiedResendWebhook = typeof VerifiedResendWebhookSchema.Type;
