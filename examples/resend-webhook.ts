import { Effect } from "effect";
import type { Redacted } from "effect";
import {
  ResendWebhookVerifier,
  resendWebhookLayer,
  parseResendWebhookEvent,
} from "../src/resend-webhook-verifier.js";
import type { ResendWebhookRequest } from "../src/resend-webhook-verifier.js";

export const authenticateResendWebhook = Effect.fnUntraced(function* authenticateResendWebhook(
  request: ResendWebhookRequest,
) {
  const verifier = yield* ResendWebhookVerifier;

  return yield* verifier.verify(request);
});

export const parseIncomingResendEvent = Effect.fnUntraced(function* parseIncomingResendEvent(
  request: ResendWebhookRequest,
) {
  const proof = yield* authenticateResendWebhook(request);

  return yield* parseResendWebhookEvent(proof);
});

export const incomingResendWebhookLayer = (signingSecret: Redacted.Redacted) =>
  resendWebhookLayer({ signingSecrets: [signingSecret] });
