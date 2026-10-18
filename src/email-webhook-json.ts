import { Effect, Schema } from "effect";
import { parseEmailBoundedJson } from "./email-bounded-json.js";
import { EmailWebhookBodySchema } from "./email-webhook-body.js";
import { EmailWebhookNormalizationError } from "./email-webhook-normalization-error.js";

export const parseEmailWebhookJson = (body: string) =>
  parseEmailBoundedJson(body).pipe(
    Effect.mapError((failure) => new EmailWebhookNormalizationError({ reason: failure.reason })),
  );

export const parseEmailWebhookBody = Effect.fnUntraced(function* parseEmailWebhookBody(
  body: string,
): Effect.fn.Return<unknown, EmailWebhookNormalizationError> {
  const text = yield* Schema.decodeEffect(EmailWebhookBodySchema)(body).pipe(
    Effect.mapError(() => new EmailWebhookNormalizationError({ reason: "invalid-payload" })),
  );

  return yield* parseEmailWebhookJson(text);
});
